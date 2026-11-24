import {
  hasAttachedProviderRelay,
  keptRunningProviderRelayPid,
  withProviderRelayRebind
} from '../../../provider-relay/app-provider-relays'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import { settleGoneStructuredAgentSessionGeneration } from '../host/structured-agent-session-conversation-open'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'

/** `gone`: the kept agent ended before it could be reattached, so the chat was cut after all. */
export type KeptAgentRebind = 'attached' | 'unresolved' | 'gone'

/** Reattaches the agent the terminal host kept running for this chat while Orca was closed. */
export async function rebindKeptStructuredAgentSessionAgent(
  open: (sessionId: string) => Promise<unknown>,
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<KeptAgentRebind> {
  const outcome = await withProviderRelayRebind(sessionId, async () => {
    await open(sessionId)
    return startStructuredAgentSessionAgentForOperation(context, sessionId)
  })
  if (hasAttachedProviderRelay(sessionId)) {
    return 'attached'
  }
  if (!outcome.ok) {
    context.deps.logger.warn('reattaching a kept chat agent failed', {
      scope: 'relay-rebind',
      sessionId,
      code: outcome.refusal.code,
      message: outcome.refusal.message,
      ...(outcome.refusal.details ? { details: outcome.refusal.details } : {})
    })
  }
  if (keptRunningProviderRelayPid(sessionId) !== null) {
    return 'unresolved'
  }
  // Open skipped settling the last run's turn while the agent was kept; it ended, so settle now.
  const session = context.sessions.get(sessionId)
  if (session && !session.child) {
    await context.serialize(sessionId, () =>
      settleGoneStructuredAgentSessionGeneration(context.deps, sessionId, session)
    )
  }
  return 'gone'
}
