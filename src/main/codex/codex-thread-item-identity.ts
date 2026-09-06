import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { CodexTurnOrdinals } from './codex-turn-ordinals'

// Codex thread items → durable journal identities.
//
// THE ORDINAL RULE, and why it is not "index within the turn". Codex renumbers
// item ids positionally on resume (`item-1`…`item-N` across the whole thread),
// and a resumed turn does NOT contain every item the live turn emitted —
// reasoning and command execution are dropped from persisted history. Numbering
// by live position would therefore shift every message after the first tool
// call and hand the user a duplicate of the assistant's answer after a resume.
//
// So the ordinal counts MESSAGE items only, and the same projection is applied
// to the live stream and to a resumed turn's item list. Any other item type —
// including ones this build does not model — is skipped identically on both
// sides, which is what makes the key survive a Codex release that adds one.

/** Only these carry a durable `(threadId, turnId, ordinal)` identity. */
const CODEX_MESSAGE_ITEM_TYPES = new Set(['userMessage', 'agentMessage'])

export type CodexThreadItem = {
  type: string
  id: string
  [key: string]: unknown
}

export function isCodexMessageItemType(type: string): boolean {
  return CODEX_MESSAGE_ITEM_TYPES.has(type)
}

export function readCodexThreadItem(value: unknown): CodexThreadItem | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  return typeof record.type === 'string' && typeof record.id === 'string'
    ? (record as CodexThreadItem)
    : null
}

/**
 * Durable identity for a Codex item, or null for one that has none.
 *
 * Non-message items fall back to the `orca` namespace keyed by the Codex item
 * id. That id is unstable across resume, so those rows are live-session detail
 * that a recovered journal simply will not contain — which is correct: Codex
 * itself does not persist them either.
 */
export function codexItemIdentity(input: {
  threadId: string
  turnId: string | null
  item: CodexThreadItem
  ordinals: CodexTurnOrdinals
}): AgentJournalItemIdentity {
  const { item, turnId } = input
  if (turnId && isCodexMessageItemType(item.type)) {
    return {
      provider: 'codex',
      threadId: input.threadId,
      turnId,
      ordinal: input.ordinals.ordinalFor(input.threadId, turnId, item.id)
    }
  }
  return { provider: 'orca', clientMessageId: `codex-item:${input.threadId}:${item.id}` }
}
