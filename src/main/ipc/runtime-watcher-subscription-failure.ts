import {
  isWatcherProcessFailure,
  type WatcherProcessFailure
} from './parcel-watcher-process-failure'

export function handleRuntimeWatcherSubscriptionFailure(
  error: unknown,
  releaseAssignment: () => void,
  retireSupervisor: (failure: WatcherProcessFailure) => void,
  quarantineOrFuseRoot: () => void
): void {
  if (isWatcherProcessFailure(error) && error.scope === 'supervisor') {
    retireSupervisor(error)
    return
  }
  releaseAssignment()
  if (isWatcherProcessFailure(error) && error.code === 'subscribe_timeout') {
    quarantineOrFuseRoot()
  }
}
