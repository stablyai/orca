import type { FsChangeEvent } from '../../shared/types'
import type { WatcherProcessEvent } from '../ipc/parcel-watcher-process'

/** Creates the conservative refresh event for a watched root. */
export function runtimeFileWatchOverflow(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
}

/** Projects watcher-process events into the runtime filesystem protocol. */
export function mapRuntimeFileWatchEvents(events: readonly WatcherProcessEvent[]): FsChangeEvent[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    isDirectory: event.isDirectory
  }))
}
