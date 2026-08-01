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
  // Whole watcher batches exceed the ordinary-lane cap; byte-pack ordered chunks instead.
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
