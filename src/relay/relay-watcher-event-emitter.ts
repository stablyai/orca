import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process'
import type { RelayDispatcher } from './dispatcher'

const FS_CHANGED = 'fs.changed'

type RelayWatcherEventPayload = {
  kind: string
  absolutePath: string
  isDirectory?: boolean
}

export function emitRelayWatcherEvents(
  dispatcher: RelayDispatcher,
  closed: boolean,
  events: readonly WatcherProcessEvent[]
): void {
  if (closed || events.length === 0) {
    return
  }
  const frameCapacity = dispatcher.broadcastProducerFrameCapacity()
  if (frameCapacity === undefined) {
    return
  }
  // Why: a whole watcher batch routinely runs tens of times over the per-frame capacity, and an
  // over-capacity frame on the ordinary lane kills the client. Chunk to fit, preserving order.
  // Sizing is exact: JSON.stringify of an array is its elements joined by commas, so the frame is
  // the empty-array envelope plus every element plus one comma per extra element. Chunks are
  // packed to the byte because each one costs a full downstream fan-out on the desktop.
  const envelopeBytes = dispatcher.notificationFrameBytes(FS_CHANGED, { events: [] })
  let chunk: RelayWatcherEventPayload[] = []
  let chunkBytes = envelopeBytes
  const flush = (): void => {
    if (chunk.length === 0) {
      return
    }
    dispatcher.notify(FS_CHANGED, { events: chunk })
    chunk = []
    chunkBytes = envelopeBytes
  }
  for (const event of events) {
    const payload: RelayWatcherEventPayload = {
      kind: event.type,
      absolutePath: event.path,
      ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload))
    // Why it can still emit an over-capacity frame: one event too large for an empty envelope
    // can't be chunked, so the ordinary-lane kill stays its backstop — a silent drop on this
    // lane has no resync contract.
    if (chunk.length > 0 && chunkBytes + 1 + payloadBytes > frameCapacity) {
      flush()
    }
    chunkBytes += payloadBytes + (chunk.length === 0 ? 0 : 1)
    chunk.push(payload)
  }
  flush()
}

export function emitRelayWatcherOverflow(
  dispatcher: RelayDispatcher,
  rootPath: string,
  closed: boolean
): void {
  if (!closed) {
    dispatcher.notify(FS_CHANGED, {
      events: [{ kind: 'overflow', absolutePath: rootPath }]
    })
  }
}
