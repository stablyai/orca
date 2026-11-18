// Why: a throwing subscriber must not abort its emitter or leak a held mutation lock.
export function notifyRuntimeListeners<L>(
  listeners: Iterable<L>,
  deliver: (listener: L) => void,
  context: string
): void {
  for (const listener of listeners) {
    try {
      deliver(listener)
    } catch (error) {
      console.error(`[runtime] ${context} listener threw`, error)
    }
  }
}
