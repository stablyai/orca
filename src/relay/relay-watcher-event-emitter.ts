import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process'
import type { RelayDispatcher } from './dispatcher'

export function emitRelayWatcherEvents(
  dispatcher: RelayDispatcher,
  closed: boolean,
  events: readonly WatcherProcessEvent[]
): void {
  if (closed || events.length === 0) {
    return
  }
  dispatcher.notify('fs.changed', {
    events: events.map((event) => ({
      kind: event.type,
      absolutePath: event.path,
      ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
    }))
  })
}

export function emitRelayWatcherOverflow(
  dispatcher: RelayDispatcher,
  rootPath: string,
  closed: boolean
): void {
  if (!closed) {
    dispatcher.notify('fs.changed', {
      events: [{ kind: 'overflow', absolutePath: rootPath }]
    })
  }
}
