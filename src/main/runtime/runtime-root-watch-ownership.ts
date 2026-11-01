import {
  isWatcherProcessFailure,
  type WatcherProcessFailure
} from '../ipc/filesystem/watcher-process/parcel-watcher-process-failure'

type RuntimeRootOwnership = {
  rootPath: string
  terminalReleaseError: WatcherProcessFailure | null
}

export function createRuntimeRootOwnershipReleaser<T extends RuntimeRootOwnership>(
  roots: Map<string, T>,
  forgetRoot: (rootPath: string) => void
): {
  release: (root: T) => void
  releaseAfterFailure: (root: T, error: Error) => void
} {
  const release = (root: T): void => {
    if (roots.get(root.rootPath) !== root) {
      return
    }
    roots.delete(root.rootPath)
    forgetRoot(root.rootPath)
  }
  const releaseAfterFailure = (root: T, error: Error): void => {
    if (!(isWatcherProcessFailure(error) && error.physicalExit)) {
      release(root)
      return
    }
    root.terminalReleaseError = error
    // Keep exact roots reserved until physical child exit; logical teardown cannot free an unkillable native watcher.
    void error.physicalExit.then(() => {
      if (root.terminalReleaseError === error) {
        root.terminalReleaseError = null
        release(root)
      }
    })
  }
  return { release, releaseAfterFailure }
}
