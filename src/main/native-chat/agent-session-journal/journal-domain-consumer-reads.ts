import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredChatNamingPrompt } from '../../../shared/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainSubmission, journalDomainInputForItem } from './journal-domain-status-inputs'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalConsumerRead =
  | { kind: 'naming-prompt'; hostStartedAt?: number }
  | { kind: 'automation-run'; messageId: string; inputIds: readonly string[] }

export type JournalConsumerReadResult =
  | { kind: 'naming-prompt'; prompt: string }
  | { kind: 'automation-run'; snapshot: AgentJournalSnapshot }

/** Consumer-specific populations never hydrate an unrelated conversation. */
export function readJournalDomainConsumer(
  scope: JournalSqlScope,
  operation: JournalConsumerRead
): JournalConsumerReadResult {
  const floor = Number(
    scope.db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
    INDEXED BY journal_items_context_clear WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...scope.prefix)?.sequence ?? 0
  )
  if (operation.kind === 'naming-prompt') {
    return { kind: operation.kind, prompt: namingPrompt(scope, floor, operation.hostStartedAt) }
  }
  const card = journalDomainQueueRow(scope.db, scope, operation.messageId)?.card
  const ids = [
    ...new Set([
      ...operation.inputIds,
      operation.messageId,
      ...(card?.consumedAs ? [card.consumedAs] : [])
    ])
  ]
  const submissions = ids.flatMap((id) => {
    const send = journalDomainSubmission(scope, id)
    return send && (floor === 0 || (send.acceptedSequence ?? 0) > floor) ? [send] : []
  })
  const items = new Map<string, { item: AgentJournalRenderItem; ordinal: number }>()
  for (const send of submissions) {
    const keys = [
      agentJournalSubmissionKey(send.clientMessageId),
      ...(send.providerItemId ? [send.providerItemId] : [])
    ]
    const candidates = keys.flatMap((key) =>
      scope.db
        .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
      INDEXED BY journal_items_opener WHERE session_id=? AND epoch=? AND hidden=0 AND opener_item_id=?
      AND root=1 AND turn_id IS NOT NULL AND sequence>? ORDER BY sequence,sequence_index,ordinal LIMIT 1`)
        .all(...scope.prefix, key, floor)
    )
    if (send.answeredInTurn?.via === 'start') {
      const row = scope.db
        .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND root=1 AND turn_id IS NOT NULL AND sequence>?`)
        .get(...scope.prefix, send.answeredInTurn.turnItemId, floor)
      if (row) {
        candidates.push(row)
      }
    }
    candidates.sort(
      (a, b) =>
        Number(a.sequence) - Number(b.sequence) ||
        Number(a.sequence_index) - Number(b.sequence_index) ||
        Number(a.ordinal) - Number(b.ordinal)
    )
    const first = candidates[0]
    if (!first) {
      continue
    }
    const turn = scope.decode<AgentJournalRenderItem>(scope.examined(first).payload_json)
    items.set(turn.itemId, { item: turn, ordinal: Number(first.ordinal) })
    let ordinal = -1
    for (;;) {
      const rows = scope.db
        .prepare(`SELECT ordinal,payload_json FROM journal_items INDEXED BY journal_items_stop_turn
        WHERE session_id=? AND epoch=? AND hidden=0 AND turn_item_id=? AND ordinal>?
        AND root=1 AND kind='message' AND message_role='assistant' AND turn_scope_kind='turn' AND sequence>?
        ORDER BY ordinal LIMIT 128`)
        .all(...scope.prefix, turn.itemId, ordinal, floor)
      for (const row of rows) {
        const item = scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json)
        items.set(item.itemId, { item, ordinal: Number(row.ordinal) })
      }
      if (rows.length < 128) {
        break
      }
      ordinal = Number(rows.at(-1)!.ordinal)
    }
  }
  return {
    kind: operation.kind,
    snapshot: {
      sessionId: scope.sessionId,
      cursor: journalDomainContextHead(scope.db, scope),
      submissions,
      items: [...items.values()]
        .sort(
          (a, b) =>
            a.item.sequence - b.item.sequence ||
            (a.item.sequenceIndex ?? 0) - (b.item.sequenceIndex ?? 0) ||
            a.ordinal - b.ordinal
        )
        .map((entry) => entry.item)
    }
  }
}

function namingPrompt(scope: JournalSqlScope, floor: number, hostStartedAt?: number): string {
  let after = [floor, -1, -1]
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
      INDEXED BY journal_items_root_position WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
      AND kind='message' AND message_role='user' AND command_entry=0 AND sequence>?
      AND (sequence,sequence_index,ordinal)>(?,?,?) ORDER BY sequence,sequence_index,ordinal LIMIT ?`)
      .all(...scope.prefix, floor, ...after, hostStartedAt === undefined ? 128 : 2)
    const items = rows.map((row) =>
      scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json)
    )
    if (hostStartedAt !== undefined) {
      if (items.length !== 1) {
        return ''
      }
      const first = items[0]
      const alias = scope.db
        .prepare(`SELECT item_id FROM journal_item_aliases
        WHERE session_id=? AND epoch=? AND provider_item_id=?`)
        .get(...scope.prefix, first.itemId)
      const input = journalDomainInputForItem(
        scope,
        alias ? String(scope.examined(alias).item_id) : first.itemId
      )
      const send =
        input &&
        (input.providerItemId === first.itemId ||
          agentJournalSubmissionKey(input.clientMessageId) === first.itemId)
          ? input
          : undefined
      return firstStructuredChatNamingPrompt(
        {
          sessionId: scope.sessionId,
          cursor: journalDomainContextHead(scope.db, scope),
          items,
          submissions: send && (floor === 0 || (send.acceptedSequence ?? 0) > floor) ? [send] : []
        },
        hostStartedAt
      )
    }
    const prompt = firstStructuredAgentSessionPrompt(items)
    if (prompt || rows.length < 128) {
      return prompt
    }
    const last = rows.at(-1)!
    after = [Number(last.sequence), Number(last.sequence_index), Number(last.ordinal)]
  }
}
