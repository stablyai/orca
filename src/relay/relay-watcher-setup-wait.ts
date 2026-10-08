import { isWatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import type { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import type { RequestContext } from './dispatcher'
import type { RelayWatcherTeardownState } from './relay-watcher-teardown-tracker'

export async function startInitialRelayWatch(
  state: RelayWatcherTeardownState,
  subscribe: () => Promise<void>,
  emitOverflow: () => void,
  close: () => Promise<void>
): Promise<void> {
  try {
    await subscribe()
  } catch (firstError) {
    if (!state.closed && shouldRetryInitialRelayWatch(firstError)) {
      try {
        await subscribe()
        emitOverflow()
        return
      } catch (quarantineError) {
        void close().catch(() => {})
        throw quarantineError
      }
    }
    void close().catch(() => {})
    throw firstError
  }
}

export async function awaitRelayWatcherSetupForClient(
  state: RelayWatcherTeardownState,
  context: RequestContext | undefined,
  releaseClient: () => void
): Promise<void> {
  try {
    await awaitRelayWatcherSetup(state.setupWaiters, context?.signal)
  } catch (error) {
    releaseClient()
    const expectedAbort =
      (error instanceof Error && error.name === 'AbortError') ||
      (isWatcherProcessFailure(error) && error.code === 'subscribe_aborted')
    if (expectedAbort) {
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[relay] File watcher not available for ${state.rootPath}: ${message}\n`)
    throw error
  }
  if (context?.isStale()) {
    releaseClient()
  }
}

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
