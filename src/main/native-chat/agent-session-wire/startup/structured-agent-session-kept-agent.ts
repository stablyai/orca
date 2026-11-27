import {
  hasAttachedProviderRelay,
  providerRelayRunLiveness,
  withProviderRelayRebind
} from '../../../provider-relay/app-provider-relays'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import { settleGoneStructuredAgentSessionGeneration } from '../host/structured-agent-session-conversation-open'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'
import { forgetIdleProviderRelayRunVerdict } from '../../../provider-relay/provider-relay-launch-inventory'

/** `gone`: the kept agent ended before it could be reattached, so the chat was cut after all. */
export type KeptAgentRebind = 'attached' | 'unresolved' | 'gone'

/** Reattaches the agent the terminal host kept running for this chat while Orca was closed. */
export async function rebindKeptStructuredAgentSessionAgent(
  open: (sessionId: string) => Promise<unknown>,
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<KeptAgentRebind> {
  try {
    return await rebind(open, context, sessionId)
  } finally {
    // A chat that never opened has no retry or close to clear its undecided run; its next open asks.
    if (!context.sessions.has(sessionId)) {
      forgetIdleProviderRelayRunVerdict(sessionId)
    }
  }
}

async function rebind(
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
  // Only its daemon start's word (or proof) ends the run, never what this app's maps hold: an
  // abandoned rebind's agent (handed back at quit) is listed again and stays unresolved.
  const record = context.deps.store.getRecord(sessionId)
  if (record && (await providerRelayRunLiveness(record, { fresh: true })) !== 'gone') {
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
