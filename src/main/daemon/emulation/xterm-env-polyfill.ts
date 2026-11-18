// Import before @xterm/headless: ELECTRON_RUN_AS_NODE lacks the window global its environment check expects.
if (globalThis.window === undefined) {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
