import type { CodexAppServerConnectionHandlers } from './codex-app-server-connection'
import type { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { CODEX_RECEIPT_TIMED_METHODS } from './codex-structured-session-state'
import { codexThreadIsActive, readCodexThreadId } from './codex-structured-thread-facts'

/** Stamp provider receipt before pre-publication buffering or retry. */
export function codexAcquisitionNotificationHandler(input: {
  acquisition: CodexAcquisitionWindow
  sessionId: string
  dispatchEchoes: CodexDispatchEchoes
  primaryThreadId: () => string | null
  notificationRetries: CodexStructuredNotificationRetry
  deliver: (
    acquisition: CodexAcquisitionWindow,
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  now: () => number
}): NonNullable<CodexAppServerConnectionHandlers['onNotification']> {
  return (method, params) => {
    const observedAt = CODEX_RECEIPT_TIMED_METHODS.has(method) ? input.now() : undefined
    const dispatchSequenceAtReceipt =
      method === 'turn/started' ? input.dispatchEchoes.latestSequence() : undefined
    // Stamp status on receipt so buffering cannot reorder it relative to replies.
    const threadId = readCodexThreadId(params)
    if (method === 'thread/status/changed' && threadId && threadId === input.primaryThreadId()) {
      input.dispatchEchoes.observeStatus(codexThreadIsActive(params))
    }
    input.deliver(
      input.acquisition,
      input.sessionId,
      () =>
        input.notificationRetries.handle(
          input.sessionId,
          method,
          params,
          observedAt,
          dispatchSequenceAtReceipt
        ),
      Buffer.byteLength(JSON.stringify(params ?? null), 'utf8')
    )
  }
}
