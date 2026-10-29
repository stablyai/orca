import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { CodexTurnOrdinals } from './codex-turn-ordinals'

// Count only messages: resumed history can omit other items and renumber provider IDs.
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

/** Separate live/history fallback namespaces because non-message provider IDs can change on resume. */
export function codexItemIdentity(input: {
  threadId: string
  turnId: string | null
  item: CodexThreadItem
  ordinals: CodexTurnOrdinals
  historyImport?: true
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
  return {
    provider: 'orca',
    clientMessageId: input.historyImport
      ? `codex-history-item:${JSON.stringify([1, input.threadId, turnId, item.id])}`
      : `codex-item:${input.threadId}:${item.id}`
  }
}
