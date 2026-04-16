// @xterm/headless checks for `window` to detect browser vs node environment.
// In ELECTRON_RUN_AS_NODE mode, `window` is undefined. This polyfill must be
// imported before any @xterm/headless import.
if (typeof globalThis.window === 'undefined') {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
