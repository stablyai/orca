import type { NativeChatTaskList } from '../../../shared/native-chat/input/task-lists/native-chat-task-list'
import { readJournalDomainLatestTaskList } from './journal-domain-latest-task-list'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { firstStructuredChatNamingPrompt } from '../../../shared/native-chat/transcript/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainSubmission, journalDomainInputForItem } from './journal-domain-status-inputs'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { automationResultNoteOf } from '../../../shared/bots/bot-automation-result-note'
import type { BotMemorySources } from '../../../shared/bots/bot-memory-source'
import { readJournalDomainBotMemorySources } from './journal-domain-bot-memory-sources'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  readJournalDomainOperationWindow,
  type JournalOperationWindow,
  type JournalOperationWindowAnchors
} from './journal-domain-operation-window'
import {
  readJournalDomainAcceptedSendOfRow,
  readJournalDomainEndedTurnCount,
  readJournalDomainOperationSent,
  readJournalDomainPromptItem,
  readJournalDomainRunMentions,
  readJournalDomainSendFingerprints,
  readJournalDomainTurnRanSince
} from './journal-domain-send-and-prompt-reads'
import {
  readJournalDomainFirstSubmittedPrompt,
  type JournalFirstSubmittedPrompt
} from './journal-domain-first-submitted-prompt'

import {
  readJournalDomainTurnAttribution,
  type JournalTurnAttribution,
  type JournalTurnNaming
} from './journal-domain-turn-attribution'
export type JournalConsumerRead =
  | { kind: 'naming-prompt'; hostStartedAt?: number }
  | { kind: 'automation-run'; messageId: string; inputIds: readonly string[] }
  /** Where a bot chat's person messages after `after` came from; all of them when null. */
  | { kind: 'bot-memory-sources'; after: number | null }
  /** Automation-result notes since the last clear, with the sends that read them. */
  | { kind: 'automation-result-notes' }
  | { kind: 'operation-window'; anchors: JournalOperationWindowAnchors }
  | { kind: 'turn-attribution'; turnId: string; through: number; naming?: JournalTurnNaming }
  | { kind: 'prompt-item'; end: 'first' | 'last' }
  | { kind: 'latest-task-list' }
  | { kind: 'run-mentions'; runId: string }
  | { kind: 'turn-ran-since'; openedAt: number | null }
  | { kind: 'ended-turn-count' }
  | { kind: 'send-fingerprints' }
  /** Whether a send carries this id as its own or as the queued card it took. */
  | { kind: 'operation-sent'; operationId: string }
  | { kind: 'accepted-send-of-row'; itemId: string | null }
  | { kind: 'first-submitted-prompt'; sinceMs: number }

export type JournalConsumerReadResult =
  | { kind: 'naming-prompt'; prompt: string }
  | { kind: 'automation-run'; snapshot: AgentJournalSnapshot }
  | { kind: 'bot-memory-sources'; sources: BotMemorySources }
  | { kind: 'automation-result-notes'; snapshot: AgentJournalSnapshot }
  | { kind: 'operation-window'; window: JournalOperationWindow }
  | { kind: 'turn-attribution'; attribution: JournalTurnAttribution }
  | { kind: 'prompt-item'; item: AgentJournalRenderItem | null }
  | { kind: 'latest-task-list'; list: NativeChatTaskList | null }
  | {
      kind: 'run-mentions'
      items: AgentJournalRenderItem[]
      sent: AgentJournalRenderItem[]
    }
  | { kind: 'turn-ran-since'; ran: boolean }
  | { kind: 'ended-turn-count'; count: number }
  | { kind: 'send-fingerprints'; sends: { clientMessageId: string; fingerprint: string }[] }
  | { kind: 'operation-sent'; sent: boolean }
  | { kind: 'accepted-send-of-row'; submission: AgentJournalSubmission | null }
  | { kind: 'first-submitted-prompt'; first: JournalFirstSubmittedPrompt }

/** Consumer-specific populations never hydrate an unrelated conversation. */
export function readJournalDomainConsumer(
  scope: JournalSqlScope,
  operation: JournalConsumerRead
): JournalConsumerReadResult {
  if (operation.kind === 'turn-attribution') {
    return {
      kind: operation.kind,
      attribution: readJournalDomainTurnAttribution(
        scope,
        operation.turnId,
        operation.through,
        operation.naming
      )
    }
  }
  if (operation.kind === 'first-submitted-prompt') {
    return {
      kind: operation.kind,
      first: readJournalDomainFirstSubmittedPrompt(scope, operation.sinceMs)
    }
  }
  const floor = Number(
    scope.db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
    INDEXED BY journal_items_context_clear WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...scope.prefix)?.sequence ?? 0
  )
  if (operation.kind === 'naming-prompt') {
    return { kind: operation.kind, prompt: namingPrompt(scope, floor, operation.hostStartedAt) }
  }
  if (operation.kind === 'bot-memory-sources') {
    return {
      kind: operation.kind,
      sources: readJournalDomainBotMemorySources(scope, operation.after)
    }
  }
  if (operation.kind === 'automation-result-notes') {
    return { kind: operation.kind, snapshot: readAutomationResultNotes(scope, floor) }
  }
  switch (operation.kind) {
    case 'operation-window':
      return {
        kind: operation.kind,
        window: readJournalDomainOperationWindow(scope, operation.anchors)
      }
    case 'prompt-item':
      return { kind: operation.kind, item: readJournalDomainPromptItem(scope, operation.end) }
    case 'latest-task-list':
      return { kind: operation.kind, list: readJournalDomainLatestTaskList(scope) }
    case 'run-mentions':
      return { kind: operation.kind, ...readJournalDomainRunMentions(scope, operation.runId) }
    case 'turn-ran-since':
      return { kind: operation.kind, ran: readJournalDomainTurnRanSince(scope, operation.openedAt) }
    case 'ended-turn-count':
      return { kind: operation.kind, count: readJournalDomainEndedTurnCount(scope) }
    case 'send-fingerprints':
      return { kind: operation.kind, sends: readJournalDomainSendFingerprints(scope) }
    case 'accepted-send-of-row':
      return {
        kind: operation.kind,
        submission: readJournalDomainAcceptedSendOfRow(scope, operation.itemId)
      }
    case 'operation-sent':
      return {
        kind: operation.kind,
        sent: readJournalDomainOperationSent(scope, operation.operationId)
      }
    case 'automation-run':
      break
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

/** Status rows since the clear that are automation-result notes, and each reading send. */
function readAutomationResultNotes(scope: JournalSqlScope, floor: number): AgentJournalSnapshot {
  const items = scope.db
    .prepare(`SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
    AND kind='status' AND sequence>? ORDER BY sequence,sequence_index,ordinal`)
    .all(...scope.prefix, floor)
    .map((row) => scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json))
    .filter((item) => item.body.kind === 'status' && automationResultNoteOf(item.body) !== null)
  const readers = new Set(
    items.flatMap((item) => {
      const note = item.body.kind === 'status' ? automationResultNoteOf(item.body) : null
      return note?.readWith ? [note.readWith] : []
    })
  )
  return {
    sessionId: scope.sessionId,
    cursor: journalDomainContextHead(scope.db, scope),
    items,
    submissions: [...readers].flatMap((id) => journalDomainSubmission(scope, id) ?? [])
  }
}
