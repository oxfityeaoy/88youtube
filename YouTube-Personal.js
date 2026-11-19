// YouTube / Music 个人版，供 Surge 使用。脚本在本地处理响应。
// 协议字段参考 Maasea/sgmodule（Apache-2.0），实现为独立的按字段改写。
// https://github.com/Maasea/sgmodule/tree/65075cdb388fc5e3094afd7e7314c67b243f3525/Script/Youtube
// https://protobuf.dev/programming-guides/encoding/

(() => {
  "use strict";

  const EMPTY = new Uint8Array(0);
  const VARINT = 0;
  const MESSAGE = 2;
  const MAX_FIELDS = 20000;
  const API_URL = /^https:\/\/youtubei(?:-att)?\.googleapis\.com\/youtubei\/v1\/([^?]+)(?:\?.*)?$/;

  // 直接保留未经修改字段的原始字节，包括未知字段及其顺序。
  function readVarint(cursor, width = 10) {
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      if (cursor.offset >= cursor.bytes.length) break;
      const byte = cursor.bytes[cursor.offset++];
      if (index === 9 && byte > 1) break;
      value += (byte & 127) * 2 ** (index * 7);
      if (byte < 128) return value;
    }
    throw new Error("invalid varint");
  }

  function* fields(bytes) {
    const cursor = { bytes, offset: 0 };
    let count = 0;
    while (cursor.offset < bytes.length) {
      if (++count > MAX_FIELDS) throw new Error("too many fields");
      const start = cursor.offset;
      const tag = readVarint(cursor, 5);
      const number = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!number || tag > 0xffffffff) throw new Error("invalid tag");

      let value;
      let payload;
      if (wire === VARINT) {
        value = readVarint(cursor);
      } else if (wire === MESSAGE) {
        const size = readVarint(cursor, 5);
        const end = cursor.offset + size;
        if (end > bytes.length) throw new Error("truncated message");
        payload = bytes.subarray(cursor.offset, end);
        cursor.offset = end;
      } else if (wire === 1 || wire === 5) {
        cursor.offset += wire === 1 ? 8 : 4;
        if (cursor.offset > bytes.length) throw new Error("truncated field");
      } else {
        throw new Error("unsupported wire type");
      }

      yield { number, wire, value, payload, start, end: cursor.offset };
    }
  }

  function encodeVarint(value) {
    const bytes = [];
    while (value >= 128) {
      bytes.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
    return Uint8Array.from(bytes);
  }

  function concat(parts) {
    const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  }

  function numberField(number, value) {
    return concat([encodeVarint(number * 8), encodeVarint(value)]);
  }

  function messageField(number, payload) {
    return concat([encodeVarint(number * 8 + MESSAGE), encodeVarint(payload.length), payload]);
  }

  // undefined 保留字段，null 删除字段，字节数组替换字段。
  function edit(bytes, transform) {
    const parts = [];
    let copiedThrough = 0;
    for (const field of fields(bytes)) {
      const replacement = transform(field);
      if (replacement === undefined) continue;
      parts.push(bytes.subarray(copiedThrough, field.start));
      if (replacement !== null) parts.push(replacement);
      copiedThrough = field.end;
    }
    if (!copiedThrough) return bytes;
    parts.push(bytes.subarray(copiedThrough));
    return concat(parts);
  }

  function children(bytes, transforms) {
    return edit(bytes, field => {
      const transform = transforms[field.number];
      if (field.wire !== MESSAGE || !transform) return undefined;
      const output = transform(field.payload);
      if (output === field.payload) return undefined;
      return output === null ? null : messageField(field.number, output);
    });
  }

  function messages(bytes, number) {
    const found = [];
    for (const field of fields(bytes)) {
      if (field.wire === MESSAGE && field.number === number) found.push(field.payload);
    }
    return found;
  }

  function lastNumber(bytes, number) {
    let value;
    for (const field of fields(bytes)) {
      if (field.wire === VARINT && field.number === number) value = field.value;
    }
    return value;
  }

  function setNumber(bytes, number, value) {
    let seen = false;
    const output = edit(bytes, field => {
      if (field.wire !== VARINT || field.number !== number) return undefined;
      if (seen) return null;
      seen = true;
      return field.value === value ? undefined : numberField(number, value);
    });
    return seen ? output : concat([output, numberField(number, value)]);
  }

  function upsertMessage(bytes, number, transform) {
    let seen = false;
    const output = children(bytes, {
      [number]: payload => {
        seen = true;
        return transform(payload);
      }
    });
    return seen ? output : concat([output, messageField(number, transform(EMPTY))]);
  }

  function playbackCapabilities(status, options) {
    if (options.background) {
      // playabilityStatus → background player → active
      status = upsertMessage(status, 11, wrapper =>
        upsertMessage(wrapper, 64657230, renderer => setNumber(renderer, 1, 1)));
    }
    if (options.pip) {
      // playabilityStatus → picture-in-picture → capability
      status = upsertMessage(status, 21, wrapper =>
        upsertMessage(wrapper, 151635310, renderer =>
          setNumber(setNumber(renderer, 1, 1), 8, 1)));
    }
    return status;
  }

  function player(bytes, options) {
    return children(bytes, {
      2: status => playbackCapabilities(status, options),
      7: ad => options.ads ? null : ad,
      9: tracking => options.ads ? children(tracking, { 18: () => null }) : tracking,
      68: ad => options.ads ? null : ad
    });
  }

  function containsAscii(bytes, marker) {
    for (let offset = bytes.indexOf(marker.charCodeAt(0)); offset !== -1;
         offset = bytes.indexOf(marker.charCodeAt(0), offset + 1)) {
      if (offset + marker.length > bytes.length) return false;
      let index = 1;
      while (index < marker.length && bytes[offset + index] === marker.charCodeAt(index)) {
        index += 1;
      }
      if (index === marker.length) return true;
    }
    return false;
  }

  function feedItem(item) {
    // 只在列表的单条渲染数据中识别广告标记。
    const ad = containsAscii(item, "pagead/") ||
      containsAscii(item, "pagead%2F") ||
      containsAscii(item, "inline_injection_entrypoint_layout.eml");
    return ad ? null : item;
  }

  function itemSection(bytes) {
    return children(bytes, { 1: feedItem });
  }

  function sectionList(bytes) {
    return children(bytes, {
      1: section => children(section, {
        50195462: itemSection,
        51845067: shelf => children(shelf, {
          5: content => children(content, { 51431404: itemSection })
        })
      })
    });
  }

  function feedContent(bytes) {
    return children(bytes, {
      49399797: sectionList,
      50195462: itemSection,
      58173949: renderer => children(renderer, {
        1: tab => children(tab, {
          58174010: tabRenderer => children(tabRenderer, { 4: feedContent })
        })
      })
    });
  }

  function recommendations(bytes) {
    return children(bytes, {
      7: content => children(content, {
        51779735: result => children(result, { 1: feedContent })
      }),
      8: feedContent
    });
  }

  function shorts(bytes) {
    return children(bytes, {
      2: entry => {
        const commands = messages(entry, 1);
        const endpoints = commands.flatMap(command => messages(command, 139608561));
        const params = endpoints.flatMap(endpoint => messages(endpoint, 16));
        return params.some(ad => lastNumber(ad, 1) === 1) ? null : entry;
      }
    });
  }

  const BACKGROUND_SETTING = 88478200;
  const SETTINGS_CATEGORY = 66930374;
  const BOOLEAN_SETTING = 61331416;
  const SET_CLIENT_SETTING = 81212182;
  const PLAYBACK_CATEGORY = 10135;
  const PIP_SETTING = 151;

  function hasPipSetting(category) {
    const endpoints = messages(category, 3).flatMap(setting => messages(setting, BOOLEAN_SETTING))
      .flatMap(setting => [...messages(setting, 5), ...messages(setting, 6)]);
    return endpoints.flatMap(endpoint => messages(endpoint, SET_CLIENT_SETTING))
      .flatMap(endpoint => messages(endpoint, 1))
      .flatMap(setting => messages(setting, 1))
      .some(setting => lastNumber(setting, 1) === PIP_SETTING);
  }

  function addPipSetting(category) {
    if (lastNumber(category, 4) !== PLAYBACK_CATEGORY || hasPipSetting(category)) return category;
    const settingId = messageField(1, numberField(1, PIP_SETTING));
    const command = enabled => messageField(SET_CLIENT_SETTING,
      messageField(1, concat([settingId, numberField(3, enabled)])));
    const toggle = concat([messageField(5, command(1)), messageField(6, command(0))]);
    return concat([category, messageField(3, messageField(BOOLEAN_SETTING, toggle))]);
  }

  function settings(bytes, options) {
    if (!options.background && !options.pip) return bytes;
    if (!messages(bytes, 6).length && !messages(bytes, 7).length) return bytes;
    let hasBackgroundSetting = false;
    const patchItem = item => children(item, {
      [BACKGROUND_SETTING]: renderer => {
        hasBackgroundSetting = true;
        return options.background ? setNumber(renderer, 2, 1) : renderer;
      },
      [SETTINGS_CATEGORY]: category => options.pip ? addPipSetting(category) : category
    });
    const output = children(bytes, { 6: patchItem, 7: patchItem });
    if (!options.background || hasBackgroundSetting) return output;
    const background = concat([numberField(2, 1), messageField(14, numberField(1, 1093))]);
    return concat([output, messageField(6, messageField(BACKGROUND_SETTING, background))]);
  }

  function patchProtobuf(bytes, endpoint, options) {
    switch (endpoint) {
      case "player":
        return player(bytes, options);
      case "get_watch":
        return children(bytes, {
          1: content => children(content, {
            2: response => player(response, options),
            3: next => options.ads ? recommendations(next) : next
          })
        });
      case "account/get_setting":
        return settings(bytes, options);
      case "browse":
        return options.ads ? children(bytes, { 9: feedContent, 10: feedContent }) : bytes;
      case "next":
        return options.ads ? recommendations(bytes) : bytes;
      case "search":
        return options.ads ? children(bytes, { 4: feedContent, 7: feedContent }) : bytes;
      case "reel/reel_watch_sequence":
        return options.ads ? shorts(bytes) : bytes;
      case "player/ad_break": {
        if (!options.ads) return bytes;
        // 独立广告接口。先校验 wire 格式，空消息表示无广告数据。
        const scanner = fields(bytes);
        while (!scanner.next().done) {
          // 迭代器会检查字段类型和长度。
        }
        return EMPTY;
      }
      default:
        return bytes;
    }
  }

  const JSON_AD_FIELDS = new Set([
    "adPlacements", "adSlots", "playerAds", "pageadViewthroughconversion",
    "pageadViewthroughconversionUrl", "adBreakServiceRenderer", "adBreakHeartbeatParams"
  ]);
  const JSON_AD_RENDERERS = [
    "adSlotRenderer", "displayAdRenderer", "promotedSparklesWebRenderer",
    "promotedSparklesTextSearchRenderer", "inFeedAdLayoutRenderer",
    "videoDisplayAdRenderer", "compactPromotedVideoRenderer", "searchPyvRenderer"
  ];

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function isJsonAdItem(item) {
    if (!item || typeof item !== "object") return false;
    if (item.command?.reelWatchEndpoint?.adClientParams?.isAd === true) return true;
    return [item, item.richItemRenderer?.content].some(renderer =>
      renderer && JSON_AD_RENDERERS.some(key => hasOwn(renderer, key)));
  }

  function enableJsonFeature(status, container, feature, fieldsToEnable) {
    const wrapper = status[container] ?? {};
    const renderer = wrapper[feature] ?? {};
    const changed = Object.keys(fieldsToEnable).some(key => renderer[key] !== fieldsToEnable[key]);
    if (changed) status[container] = { ...wrapper, [feature]: { ...renderer, ...fieldsToEnable } };
    return changed;
  }

  function patchJson(data, endpoint, options) {
    if (!data || typeof data !== "object" || data.error) return false;

    let changed = false;
    const pending = [data];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== "object") continue;
      if (options.ads && Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          if (!isJsonAdItem(node[index])) continue;
          node.splice(index, 1);
          changed = true;
        }
      }
      if (endpoint === "player" || endpoint === "get_watch") {
        const status = node.playabilityStatus;
        if (status?.status === "OK" && !status.reason) {
          if (options.background) {
            changed = enableJsonFeature(status, "backgroundPlayerRender",
              "backgroundAbility", { active: true }) || changed;
          }
          if (options.pip) {
            changed = enableJsonFeature(status, "pictureInPictureRender",
              "pictureInPictureAbility", { active: true, f8: 1 }) || changed;
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (options.ads && JSON_AD_FIELDS.has(key)) {
          delete node[key];
          changed = true;
        } else if (node[key] && typeof node[key] === "object") {
          pending.push(node[key]);
        }
      }
    }
    return changed;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Surge 的 JSC 引擎可能不提供 TextDecoder。
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    }
    return decodeURIComponent(escape(chunks.join("")));
  }

  function getContentType(headers = {}) {
    const key = Object.keys(headers).find(name => name.toLowerCase() === "content-type");
    return key ? String(headers[key]).split(";", 1)[0].trim().toLowerCase() : "";
  }

  function readOptions() {
    const options = { ads: true, background: true, pip: true, debug: false };
    if (typeof $argument !== "string") return options;
    for (const entry of $argument.split("&")) {
      const [key, value] = entry.split("=", 2);
      if (hasOwn(options, key) && /^(true|false)$/i.test(value)) {
        options[key] = value.toLowerCase() === "true";
      }
    }
    return options;
  }

  function rewrite(endpoint, options) {
    if (!options.ads && !options.background && !options.pip) return {};
    if ($response.status !== 200 || !($response.body instanceof Uint8Array)) return {};
    const input = $response.body;
    if (!input.length) return {};
    const type = getContentType($response.headers);
    const hasProtoQuery = /[?&]alt=(?:proto|protobuf)(?:&|$)/i.test($request.url);
    const isProtobuf = /^(?:application\/(?:x-(?:google-)?)?protobuf|application\/vnd\.google\.protobuf|application\/octet-stream)$/.test(type)
      || (hasProtoQuery && (!type || type === "text/plain"));

    if (isProtobuf) {
      const body = patchProtobuf(input, endpoint, options);
      if (body === input) return {};
      if (options.debug) console.log(`[YouTube Personal] ${endpoint} protobuf ${input.length} → ${body.length}`);
      return { body };
    }
    if (type !== "application/json" && !type.endsWith("+json")) return {};
    const text = decodeUtf8(input).replace(/^\uFEFF/, "");
    const prefix = text.match(/^\)\]\}'\r?\n/)?.[0] ?? "";
    const data = JSON.parse(text.slice(prefix.length));
    if (endpoint === "player/ad_break") {
      if (!options.ads || !data || typeof data !== "object" || data.error) return {};
      if (options.debug) console.log(`[YouTube Personal] ${endpoint} JSON`);
      return { body: prefix + (Array.isArray(data) ? "[]" : "{}") };
    }
    if (!patchJson(data, endpoint, options)) return {};
    if (options.debug) console.log(`[YouTube Personal] ${endpoint} JSON`);
    return { body: prefix + JSON.stringify(data) };
  }

  const options = readOptions();
  const endpoint = $request.url.match(API_URL)?.[1];
  let result = {};
  if (endpoint) {
    try {
      result = rewrite(endpoint, options);
    } catch {
      if (options.debug) console.log(`[YouTube Personal] ${endpoint} parse failed, response passed through`);
    }
  }
  $done(result);
})();
