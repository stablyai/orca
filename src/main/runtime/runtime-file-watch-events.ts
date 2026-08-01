import type { FsChangeEvent } from '../../shared/types'
import type { WatcherProcessEvent } from '../ipc/parcel-watcher-process'

export function runtimeFileWatchOverflow(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
}

export function mapRuntimeFileWatchEvents(events: readonly WatcherProcessEvent[]): FsChangeEvent[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    isDirectory: event.isDirectory
  }))
}
