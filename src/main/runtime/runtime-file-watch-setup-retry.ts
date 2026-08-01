import { isWatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'

export function shouldRetryInitialRuntimeWatch(error: unknown): boolean {
  return (
    isWatcherProcessFailure(error) &&
    error.code !== 'entry_missing' &&
    error.code !== 'subscribe_aborted' &&
    error.code !== 'supervisor_disposed' &&
    (error.scope === 'supervisor' || error.code === 'subscribe_timeout')
  )
}
