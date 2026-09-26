import { TerminalAttachCanceledError } from './daemon-errors'
import { PromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'

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
    createAbortError: () => new TerminalAttachCanceledError(sessionId)
  })
}
