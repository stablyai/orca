import type { WatcherProcessFailure } from './parcel-watcher-process-failure'

/** Retain exact failed-child ownership until its native handles are gone. */
export class RuntimeWatcherPredecessorBarriers {
  private readonly failures = new Map<string, WatcherProcessFailure>()

  throwIfRetained(rootPath: string): void {
    const failure = this.failures.get(rootPath)
    if (failure) {
      throw failure
    }
  }

  retain(rootPaths: Iterable<string>, failure: WatcherProcessFailure): void {
    if (!failure.physicalExit) {
      return
    }
    const retainedRoots = Array.from(rootPaths)
    for (const rootPath of retainedRoots) {
      this.failures.set(rootPath, failure)
    }
    const clearExactFailure = (): void => {
      for (const rootPath of retainedRoots) {
        if (this.failures.get(rootPath) === failure) {
          this.failures.delete(rootPath)
        }
      }
    }
    void failure.physicalExit.then(clearExactFailure, clearExactFailure)
  }

  clear(): void {
    this.failures.clear()
  }
}
