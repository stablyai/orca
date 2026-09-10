import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-provider-handle'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

export function forkJournalIdentity(
  identity: AgentJournalItemIdentity,
  source: AgentSessionProviderHandle,
  target: AgentSessionProviderHandle
): AgentJournalItemIdentity {
  if (source.provider !== target.provider) {
    throw new Error('agent_session_provider_handle_provider_mismatch')
  }
  if (identity.provider === 'codex') {
    if (
      source.provider !== 'codex' ||
      target.provider !== 'codex' ||
      identity.threadId !== source.threadId
    ) {
      throw new Error('agent_session_identity_required')
    }
    return {
      provider: 'codex',
      threadId: target.threadId,
      turnId: identity.turnId,
      ordinal: identity.ordinal
    }
  }
  // Import-scoped bridge-era rows: no provider echo can ever reconcile against one, and the
  // session id already names the provider conversation the child forks from, so it carries over
  // verbatim rather than being minted into a namespace the child cannot reproduce.
  if (identity.provider === 'legacy') {
    return identity
  }
  if (identity.provider === 'claude' && target.provider === 'claude') {
    // Forked files rewrite sessionId; retained UUIDs still belong to the parent namespace.
    return {
      provider: 'claude',
      sessionId:
        identity.sessionId === target.sessionId && source.provider === 'claude'
          ? source.sessionId
          : identity.sessionId,
      uuid: identity.uuid
    }
  }
  throw new Error('agent_session_identity_required')
}

export function forkJournalSeed(
  items: readonly { itemId: string; body: AgentJournalItemBody; observedAt: number }[],
  source: AgentSessionProviderHandle,
  target: AgentSessionProviderHandle
): JournalReplacementItem[] {
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      throw new Error('agent_session_identity_required')
    }
    // Host status and submission identities belong to the parent's operation lifecycle. So does a
    // turn-lifecycle row, whichever namespace it was keyed in — the child opens its own.
    if (identity.provider === 'orca' || (item.body.kind === 'status' && item.body.turnLifecycle)) {
      return []
    }
    const rekeyed = forkJournalIdentity(identity, source, target)
    const key = agentJournalItemKey(rekeyed)
    if (seen.has(key)) {
      throw new Error('agent_session_conflict')
    }
    seen.add(key)
    const body = structuredClone(item.body)
    if (body.kind === 'approval' || body.kind === 'question') {
      body.resolution = {
        ...body.resolution,
        state: body.resolution.state === 'pending' ? 'cancelled' : body.resolution.state,
        resolvedBy: null
      }
    }
    return [{ identity: rekeyed, body, observedAt: item.observedAt }]
  })
}
