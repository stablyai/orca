var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// orca-terminal-rail-entry.ts
var orca_terminal_rail_entry_exports = {};
__export(orca_terminal_rail_entry_exports, {
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS: () => TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
  createTerminalAccessoryRepeatController: () => createTerminalAccessoryRepeatController,
  getSideRailStrip: () => getSideRailStrip,
  hasTerminalDirectionPadSpace: () => hasTerminalDirectionPadSpace,
  sideRailStripAboveKeyboard: () => sideRailStripAboveKeyboard
});
module.exports = __toCommonJS(orca_terminal_rail_entry_exports);

// mobile/src/layout/side-rail-strip.ts
function hasTerminalDirectionPadSpace(strip) {
  return strip !== null && strip.height >= 224 && strip.width >= 60;
}
var MIN_STRIP_WIDTH = 60;
var MIN_STRIP_HEIGHT = 160;
function getSideRailStrip(args) {
  const { windowWidth, windowHeight, insets, occlusions } = args;
  for (const side of ["right", "left"]) {
    const width = insets[side];
    if (!(width >= MIN_STRIP_WIDTH)) {
      continue;
    }
    const stripStart = side === "right" ? windowWidth - width : 0;
    const stripEnd = side === "right" ? windowWidth : width;
    const inStrip = occlusions.filter(
      (region) => region.x < stripEnd && region.x + region.width > stripStart
    );
    const statusColumn = inStrip.some(
      (region) => region.x <= stripStart + 1 && region.x + region.width >= stripEnd - 1 && (region.y <= 1 || region.y + region.height >= windowHeight - 1)
    );
    if (!statusColumn) {
      continue;
    }
    const occluded = inStrip.map((region) => ({ from: region.y, to: region.y + region.height })).sort((a, b) => a.from - b.from);
    let best = { from: 0, to: 0 };
    let cursor = insets.top;
    for (const span of [...occluded, { from: windowHeight - insets.bottom, to: windowHeight }]) {
      if (span.from - cursor > best.to - best.from) {
        best = { from: cursor, to: span.from };
      }
      cursor = Math.max(cursor, span.to);
    }
    if (best.to - best.from >= MIN_STRIP_HEIGHT) {
      return {
        side,
        width,
        top: best.from,
        bottom: windowHeight - best.to,
        height: best.to - best.from
      };
    }
  }
  return null;
}
function sideRailStripAboveKeyboard(strip, keyboardHeight) {
  if (strip === null || keyboardHeight <= strip.bottom) {
    return strip;
  }
  const height = strip.height - (keyboardHeight - strip.bottom);
  return height > 0 ? { ...strip, bottom: keyboardHeight, height } : null;
}

// mobile/src/terminal/key-input/terminal-accessory-repeat.ts
var TERMINAL_ACCESSORY_REPEAT_DELAY_MS = 400;
var TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS = 45;
function createTerminalAccessoryRepeatController() {
  let generation = 0;
  let timer = null;
  const stop = () => {
    generation += 1;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const cancel = stop;
  const start = (input, send, firstRepeatDelayMs) => {
    stop();
    const activeGeneration = generation;
    const startedAt = Date.now();
    let nextRepeatDelayMs = firstRepeatDelayMs;
    const sendNext = () => {
      timer = null;
      if (generation !== activeGeneration) {
        return;
      }
      void send(input).then(
        (sent) => {
          if (sent && generation === activeGeneration) {
            const delayMs = nextRepeatDelayMs === void 0 ? TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS : Math.min(
              nextRepeatDelayMs,
              Math.max(0, nextRepeatDelayMs - (Date.now() - startedAt))
            );
            nextRepeatDelayMs = void 0;
            timer = setTimeout(sendNext, delayMs);
          }
        },
        () => void 0
      );
    };
    sendNext();
  };
  return { cancel, start, stop };
}
