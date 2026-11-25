import type { ChildProcess } from 'node:child_process'
import {
  watcherChildPhysicalExit,
  requireWatcherChildTermination
} from './parcel-watcher-child-termination'

export class WatcherOwnedChildren {
  private readonly children = new Set<ChildProcess>()
  private disposal: Promise<void> | null = null

  track(child: ChildProcess): ChildProcess {
    this.children.add(child)
    // Reuse launch-owned physical-exit evidence, including close without exit after spawn failure.
    void watcherChildPhysicalExit(child).then(() => {
      this.children.delete(child)
    })
    return child
  }

  disposeAndWait(disposeLogicalOwner: () => void): Promise<void> {
    if (this.disposal) {
      return this.disposal
    }
    const failures: unknown[] = []
    try {
      disposeLogicalOwner()
    } catch (error) {
      failures.push(error)
    }
    const cleanup = Promise.allSettled([...this.children].map(requireWatcherChildTermination))
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.push(result.reason)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'watcher_owned_children_shutdown_incomplete')
        }
      })
      .finally(() => {
        this.disposal = null
      })
    this.disposal = cleanup
    return cleanup
  }
}
