import { TerminalAttachCanceledError } from '../protocol/daemon-errors'
import { PromiseSettlementWaiters } from '../../../shared/concurrency/promise-settlement-waiters'

export function waitForTerminalAttachOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<T> {
  if (!signal) {
    return operation
  }
  return new PromiseSettlementWaiters(operation).wait({
    signal,
    abortInMicrotask: true,
    createAbortError: () => new TerminalAttachCanceledError(sessionId)
  })
}
