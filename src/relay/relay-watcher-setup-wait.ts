import { isWatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import type { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'

export function shouldRetryInitialRelayWatch(error: unknown): boolean {
  return (
    isWatcherProcessFailure(error) &&
    error.code !== 'entry_missing' &&
    error.code !== 'subscribe_aborted' &&
    error.code !== 'supervisor_disposed' &&
    (error.scope === 'supervisor' || error.code === 'subscribe_timeout')
  )
}

export function awaitRelayWatcherSetup(
  setupWaiters: PromiseSettlementWaiters<void>,
  signal?: AbortSignal
): Promise<void> {
  return setupWaiters.wait({
    signal,
    createAbortError: createRelayWatchAbortError
  })
}

function createRelayWatchAbortError(): Error {
  const error = new Error('Request "fs.watch" was cancelled')
  error.name = 'AbortError'
  return error
}
