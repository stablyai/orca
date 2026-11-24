import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyDataEvent } from '../../../providers/pty/events'

type ExitListener = Parameters<IPtyProvider['onExit']>[0]
type ExitEvent = Parameters<ExitListener>[0]

/** The degraded provider's own data and exit listeners, fed by every routed provider. */
export class DegradedDaemonListeners {
  private readonly dataListeners: ((payload: PtyDataEvent) => void)[] = []
  private readonly exitListeners: ExitListener[] = []

  onData(callback: (payload: PtyDataEvent) => void): () => void {
    return addListener(this.dataListeners, callback)
  }

  onExit(callback: ExitListener): () => void {
    return addListener(this.exitListeners, callback)
  }

  emitData(payload: PtyDataEvent): void {
    this.dataListeners.forEach((listener) => listener(payload))
  }

  emitExit(payload: ExitEvent): void {
    // Listeners may unsubscribe during iteration.
    for (const listener of Array.from(this.exitListeners)) {
      listener(payload)
    }
  }
}

function addListener<T>(listeners: T[], callback: T): () => void {
  listeners.push(callback)
  return () => {
    const idx = listeners.indexOf(callback)
    if (idx !== -1) {
      listeners.splice(idx, 1)
    }
  }
}
