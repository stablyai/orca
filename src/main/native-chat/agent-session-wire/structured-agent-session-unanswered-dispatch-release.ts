import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

/**
 * Releases doubted sends once the provider reports it has stopped running.
 *
 * A dispatch whose RPC timed out is recorded `unknown` — doubt, never proof of
 * non-delivery — and a live `unknown` reads as work still owed, so the session
 * shows working until something re-derives it. The provider reporting its thread
 * not running, with no turn open, IS that re-derivation.
 *
 * `pending` is deliberately untouched: that send's dispatch has not returned yet
 * and may be in flight right now. And `recovered` only retires the obligation —
 * it never makes a send re-deliverable, because the provider may well have run it.
 */
export async function releaseStructuredAgentSessionUnansweredDispatches(
  context: Pick<StructuredAgentSessionMutationContext, 'sessions'> & {
    deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'> }
  },
  input: { sessionId: string; reason: string }
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const stranded = session.journal
    .submissions()
    .filter((entry) => entry.dispatchState === 'unknown' && entry.recovered !== true)
  if (stranded.length === 0) {
    return
  }
  for (const entry of stranded) {
    await session.journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'unknown',
      // The earlier reason names a sharper fact than this one does.
      reason: entry.reason ?? input.reason,
      fence: structuredAgentSessionConversationFence(context.deps.store, input.sessionId),
      recovered: true
    })
  }
}
