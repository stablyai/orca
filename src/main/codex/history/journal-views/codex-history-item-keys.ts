import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { continuedOutsideRecordId } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import { codexTurnLifecycleIdentity } from '../../structured/journal/codex-structured-journal-translation-turns'
import { codexCompactionKey } from '../../structured/journal/codex-structured-journal-compactions'
import {
  codexNonMessageIdentity,
  isCodexMessageItemType
} from '../../structured/items/codex-thread-item-identity'
import { readCodexJournalRecord } from '../../structured/journal/codex-structured-journal-translation-values'

/** The source group names every saved identity its projection can consult. */
export function codexHistoryItemKeys(
  input: {
    sessionId: string
    threadId: string
    check: () => void
  },
  turn: Record<string, unknown>
): string[] {
  const turnId = String(turn.id)
  const keys = new Set([
    agentJournalItemKey(codexTurnLifecycleIdentity(input.sessionId, turnId)),
    agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: input.sessionId,
      recordId: continuedOutsideRecordId(turnId)
    }),
    agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `codex-compaction:${codexCompactionKey(input.threadId, turnId)}`
    })
  ])
  let ordinal = 0
  for (const raw of Array.isArray(turn.items) ? turn.items : []) {
    input.check()
    const item = readCodexJournalRecord(raw)
    const message = typeof item.type === 'string' && isCodexMessageItemType(item.type)
    const slot = ordinal
    if (message) {
      ordinal++
    }
    if (typeof item.id !== 'string' || typeof item.type !== 'string') {
      continue
    }
    keys.add(
      agentJournalItemKey(
        message
          ? { provider: 'codex', threadId: input.threadId, turnId, ordinal: slot }
          : codexNonMessageIdentity(input.threadId, turnId, item.id, true)
      )
    )
    keys.add(agentJournalItemKey(codexNonMessageIdentity(input.threadId, turnId, item.id)))
    for (const parent of [item.parentCallId, item.parentToolCallId]) {
      if (typeof parent === 'string') {
        keys.add(agentJournalItemKey(codexNonMessageIdentity(input.threadId, turnId, parent, true)))
        keys.add(agentJournalItemKey(codexNonMessageIdentity(input.threadId, turnId, parent)))
      }
    }
    if (typeof item.clientId === 'string') {
      keys.add(agentJournalItemKey({ provider: 'orca', clientMessageId: item.clientId }))
    }
  }
  return [...keys]
}
