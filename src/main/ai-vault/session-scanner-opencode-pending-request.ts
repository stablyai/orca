import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { OpenCodeSqliteWorkerRequest } from './session-scanner-opencode-sqlite-worker-protocol'
import { getSessionSearchCaptureSignal } from './session-search-capture'
import type { OpenCodeCaptureConsumer } from './session-search-opencode-capture-channel'

/** One request the client has accepted: queued or active, with its own deadline. */
export type OpenCodePendingCall = {
  request: OpenCodeSqliteWorkerRequest
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  capture?: OpenCodeCaptureConsumer
}

/**
 * The request owns its abort listener until either queued or active work settles.
 * Applies to every request kind, not just capturing parses: a backfill abort
 * cancels the `list` legs it queued too.
 */
export function bindOpenCodeRequestCancellation(
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
  cancel: () => void
): { resolve: typeof resolve; reject: typeof reject } {
  const signal = getSessionSearchCaptureSignal()
  throwIfAiVaultScanCancelled(signal)
  signal?.addEventListener('abort', cancel, { once: true })
  const cleanup = (): void => signal?.removeEventListener('abort', cancel)
  return {
    resolve: (value) => {
      cleanup()
      resolve(value)
    },
    reject: (error) => {
      cleanup()
      reject(error)
    }
  }
}
