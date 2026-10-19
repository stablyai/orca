export type RuntimeTerminalDataMeta = Readonly<{
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
}>

type TerminalDataListener = (data: string, meta?: RuntimeTerminalDataMeta) => void

export class RuntimeTerminalStreamConsumers {
  private readonly dataListeners = new Map<string, Set<TerminalDataListener>>()

  subscribe(ptyId: string, listener: TerminalDataListener): () => void {
    const listeners = this.dataListeners.get(ptyId) ?? new Set<TerminalDataListener>()
    listeners.add(listener)
    this.dataListeners.set(ptyId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.dataListeners.delete(ptyId)
      }
    }
  }

  publish(ptyId: string, data: string, getMeta: () => RuntimeTerminalDataMeta): void {
    const listeners = this.dataListeners.get(ptyId)
    if (!listeners) {
      return
    }
    const meta = getMeta()
    for (const listener of listeners) {
      try {
        listener(data, meta)
      } catch (error) {
        // Why: this hot path avoids a per-chunk closure while preserving listener isolation.
        console.error('[runtime] pty-data listener threw', error)
      }
    }
  }
}
