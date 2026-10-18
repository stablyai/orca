// What a test may ask of the host's retry (`StructuredAgentSessionRetry`) that no production caller
// does: whether a chat is still owed, and waiting until it is not.

import { vi } from 'vitest'
import { RECONCILIATION_BACKOFF_MS } from './structured-agent-session-reconciliation-backoff'
import type { StructuredAgentSessionRetry } from './structured-agent-session-reconciliation-retry'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

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
    const attempt = retry.attempted(sessionId)
    // A lane an operation held (an open's own, say) waits out the timer's first step.
    if (vi.isFakeTimers() && retry['timer'] !== null && retry['timer'] !== 'soon') {
      await vi.advanceTimersByTimeAsync(RECONCILIATION_BACKOFF_MS.max)
    }
    await attempt
  }
}

/** A released chat settles on its first open: open it, then wait for that settlement. */
export async function openAndSettle(
  host: Pick<StructuredAgentSessionHost, 'journalSnapshot' | 'collaboratorsForTests'>,
  sessionId: string
): Promise<void> {
  await host.journalSnapshot(sessionId)
  await retryIdle(host.collaboratorsForTests().reconciliation, sessionId)
}
