/** The listener surface of Node's EventEmitter, which WebContents, BrowserWindow and ipcMain share. */
export type FanoutEventSource = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>

// Callers declare the emitter's own argument types, exactly as with a direct `on`.
type FanoutCallback = (...args: any[]) => void

type EventFanout = {
  listener: FanoutCallback
  callbacks: Set<FanoutCallback>
}

const fanoutsBySource = new WeakMap<FanoutEventSource, Map<string, EventFanout>>()

/**
 * Subscribe through one shared native listener per (emitter, event).
 * Why: per-request listeners on long-lived emitters (main window, its WebContents, ipcMain)
 * pile up past Node's 10-listener warning whenever operations overlap, even with cleanup.
 */
export function addFanoutListener(
  source: FanoutEventSource,
  event: string,
  callback: FanoutCallback
): () => void {
  let fanouts = fanoutsBySource.get(source)
  if (!fanouts) {
    fanouts = new Map()
    fanoutsBySource.set(source, fanouts)
  }
  let fanout = fanouts.get(event)
  if (!fanout) {
    const callbacks = new Set<FanoutCallback>()
    const created: EventFanout = {
      callbacks,
      // Snapshot so callbacks that unsubscribe or subscribe while dispatching stay well-defined.
      listener: (...args) => {
        for (const registered of Array.from(callbacks)) {
          if (callbacks.has(registered)) {
            registered(...args)
          }
        }
      }
    }
    fanout = created
    fanouts.set(event, created)
    source.on(event, created.listener)
  }
  const active = fanout
  const ownCallback: FanoutCallback = (...args) => callback(...args)
  active.callbacks.add(ownCallback)
  return () => {
    if (!active.callbacks.delete(ownCallback) || active.callbacks.size > 0) {
      return
    }
    source.removeListener(event, active.listener)
    const current = fanoutsBySource.get(source)
    if (current?.get(event) === active) {
      current.delete(event)
      if (current.size === 0) {
        fanoutsBySource.delete(source)
      }
    }
  }
}

/** Subscribe one callback to several lifecycle events; the returned function releases all of them. */
export function addFanoutListeners(
  source: FanoutEventSource,
  events: readonly string[],
  callback: FanoutCallback
): () => void {
  const releases = events.map((event) => addFanoutListener(source, event, callback))
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const release of releases) {
      release()
    }
  }
}
