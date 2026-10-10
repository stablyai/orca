// What a test may ask of the host's retry (`StructuredAgentSessionRetry`) that no production caller
// does: whether a chat is still owed, and waiting until it is not.

import type { StructuredAgentSessionRetry } from './structured-agent-session-reconciliation-retry'

/** Whether a visit is owed: something was signalled, or failed, and has not settled. */
export function retryOwes(retry: StructuredAgentSessionRetry, sessionId: string): boolean {
  return retry['owed'].get(sessionId)?.due === true
}

/** Resolves once the chat owes nothing, or a failed round left it waiting out a backoff. */
export async function retryIdle(
  retry: StructuredAgentSessionRetry,
  sessionId: string
): Promise<void> {
  while (
    retryOwes(retry, sessionId) &&
    (retry['running'] || retry['timer'] === 'soon' || retry['failures'] === 0)
  ) {
    await retry.attempted(sessionId)
  }
}
