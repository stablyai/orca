import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  codexNonMessageIdentity,
  isCodexMessageItemType,
  type CodexThreadItem
} from './codex-thread-item-identity'
import type { CodexHistoryObservedTurn, HistoryAnchor } from './codex-history-source-facts'

export function codexHistoryAddresses(input: {
  threadId: string
  journal: StructuredAgentSessionTransitionJournal
}) {
  const row = (key: string) => input.journal.item(input.journal.canonicalItemId(key))
  const sameTurn = (
    saved: AgentJournalRenderItem,
    key: string,
    turn: CodexHistoryObservedTurn
  ): boolean => {
    if (saved.turnScope?.kind === 'turn') {
      return input.journal.canonicalItemId(saved.turnScope.turnItemId) === turn.key
    }
    const identity = parseAgentJournalItemKey(key)
    if (identity?.provider === 'codex') {
      return identity.threadId === input.threadId && identity.turnId === turn.id
    }
    if (
      identity?.provider === 'orca' &&
      identity.clientMessageId.startsWith('codex-history-item:')
    ) {
      const encoded = identity.clientMessageId.slice('codex-history-item:'.length)
      const parts: unknown = JSON.parse(encoded)
      return Array.isArray(parts) && parts[1] === input.threadId && parts[2] === turn.id
    }
    return false
  }
  const address = (
    identity: AgentJournalItemIdentity,
    item: CodexThreadItem,
    turn: CodexHistoryObservedTurn
  ) => {
    const key = agentJournalItemKey(identity)
    const resolved = (
      identity: AgentJournalItemIdentity,
      key: string,
      saved: AgentJournalRenderItem | null
    ) => {
      const canonical = input.journal.canonicalItemId(key)
      return {
        identity: parseAgentJournalItemKey(canonical) ?? identity,
        saved,
        key: canonical,
        aliases: saved && canonical !== key ? [{ key, saved }] : []
      }
    }
    const history = row(key)
    if (history) {
      return sameTurn(history, key, turn) ? resolved(identity, key, history) : null
    }
    if (!isCodexMessageItemType(item.type)) {
      const live = codexNonMessageIdentity(input.threadId, turn.id, item.id)
      const liveKey = agentJournalItemKey(live),
        saved = row(liveKey)
      if (saved && sameTurn(saved, liveKey, turn)) {
        return resolved(live, liveKey, saved)
      }
    }
    return resolved(identity, key, null)
  }
  const savedParent = (id: string, turn: CodexHistoryObservedTurn): HistoryAnchor | null => {
    for (const identity of [
      codexNonMessageIdentity(input.threadId, turn.id, id, true),
      codexNonMessageIdentity(input.threadId, turn.id, id)
    ]) {
      const key = agentJournalItemKey(identity),
        saved = row(key)
      if (saved && sameTurn(saved, key, turn) && !input.journal.presentationRemoved(key)) {
        return { key, saved }
      }
    }
    return null
  }
  return { address, savedParent }
}
