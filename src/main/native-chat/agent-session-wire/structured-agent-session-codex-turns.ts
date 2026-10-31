import { asRecord } from '../../ai-vault/session-scanner-values'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

// Codex rollout facts the resting importer reads beside its message rows.

export function lifecycleIdentity(threadId: string, turnId: string) {
  return {
    provider: 'legacy' as const,
    agent: 'codex' as const,
    sessionId: threadId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

/** A sub-agent's turn names its parent; it neither ends nor opens a root turn. */
export function codexChildTurn(payload: Record<string, unknown> | null): boolean {
  const parent = asRecord(payload?.turn_attribution)?.parent_turn_id ?? payload?.parent_turn_id
  return typeof parent === 'string' && parent !== ''
}

/** Saved prompt rows of this thread by provider item id, under either import's identity scheme. */
export function savedCodexPrompts(
  journal: AgentSessionJournal,
  threadId: string
): Map<string, string> {
  const prompts = new Map<string, string>()
  journal.visitItemsWithLinkage((itemId, _sequence, body) => {
    const identity = parseAgentJournalItemKey(itemId)
    if (
      identity?.provider === 'legacy' &&
      identity.agent === 'codex' &&
      identity.sessionId === threadId &&
      body.kind === 'message' &&
      body.role === 'user'
    ) {
      prompts.set(sharedRecordId(identity.recordId), itemId)
    }
  })
  return prompts
}

/** Paginated imports prefix the rollout id; the bare provider id is the shared part. */
function sharedRecordId(recordId: string): string {
  return recordId.slice(recordId.lastIndexOf(':') + 1)
}

/** A prompt another import named, as the resting importer finds or writes it. */
export function codexRestingPromptKey(
  journal: AgentSessionJournal,
  threadId: string,
  key: string
): string {
  const identity = parseAgentJournalItemKey(key)
  if (identity?.provider !== 'legacy') {
    return journal.canonicalItemId(key)
  }
  const id = sharedRecordId(identity.recordId)
  return (
    savedCodexPrompts(journal, threadId).get(id) ??
    agentJournalItemKey({ ...identity, recordId: id })
  )
}

export function providerItemId(record: Record<string, unknown> | null): string | null {
  const payload = asRecord(record?.payload)
  const id = asRecord(payload?.item)?.id ?? payload?.id ?? record?.id
  return typeof id === 'string' && id ? id : null
}
