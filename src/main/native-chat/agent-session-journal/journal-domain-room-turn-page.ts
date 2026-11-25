import { indexBotGroupJournal } from '../../../shared/bots/bot-group'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem,
  type HistoryItemForm
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import {
  readJournalDomainClientForms,
  readJournalDomainClientItems
} from './journal-domain-item-presentation'
import { readJournalDomainOperationWindow } from './journal-domain-operation-window'
import {
  admitJournalDomainHistoryGroups,
  readJournalDomainHistoryEnvelope,
  selectJournalDomainHistoryWindow
} from './journal-domain-history-window'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalRoomTurnPageRequest = {
  operationId: string
  turnItemId?: string
  workerDispatchIds?: readonly string[]
  beforeSequence?: number
}

export type JournalRoomTurnPage = { items: AgentJournalRenderItem[]; beforeSequence?: number }

const DETAIL_LIMIT = 128
const SCOPE =
  'session_id=? AND epoch=? AND hidden=0 AND turn_item_id IS NOT NULL AND turn_item_id=?'

export function readJournalDomainRoomTurnPage(
  scope: JournalSqlScope,
  request: JournalRoomTurnPageRequest
): JournalRoomTurnPage {
  const turnId = request.turnItemId ?? legacyTurnItemId(scope, request.operationId)
  if (!turnId) {
    return { items: [] }
  }
  const { db, prefix } = scope
  const first = request.beforeSequence === undefined
  // The lifecycle and newest answer are visible from the first page even after much later work.
  const answer = first
    ? db
        .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_turn_detail_answer
        WHERE ${SCOPE} AND root=1 AND message_role='assistant' AND assistant_prose=1
        ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
        .get(...prefix, turnId)
    : undefined
  const pinnedIds = first ? [turnId, ...(answer ? [String(answer.item_id)] : [])] : []
  const pinned = readJournalDomainClientForms(db, scope, pinnedIds)
  let remaining = HISTORY_PAGE_CONTENT_BUDGET_BYTES
  const items = new Map<string, AgentJournalRenderItem>()
  for (const [id, form] of pinned) {
    if (form.bytes <= remaining) {
      items.set(id, form.item)
      remaining -= form.bytes + 1
    }
  }
  const end = request.beforeSequence ?? Number.MAX_SAFE_INTEGER
  const window = selectJournalDomainHistoryWindow(db, SCOPE, [...prefix, turnId], end, DETAIL_LIMIT)
  const forms = new Map<string, HistoryItemForm>(pinned)
  const { groups, oversized } = admitJournalDomainHistoryGroups(window, remaining, db, scope, forms)
  const selected = groups.flat()
  if (oversized) {
    for (const { itemId } of selected) {
      if (!items.has(itemId)) {
        items.set(
          itemId,
          oversizedHistoryItem(readJournalDomainHistoryEnvelope(db, prefix, itemId))
        )
      }
    }
  } else {
    for (const item of readJournalDomainClientItems(
      db,
      scope,
      selected.map(({ itemId }) => itemId),
      forms
    )) {
      items.set(item.itemId, item)
    }
  }
  if (first && request.workerDispatchIds?.length) {
    const linked = request.workerDispatchIds.map((id) =>
      agentJournalSubmissionKey(`agent-start:${id}`)
    )
    // Workers are stored beside the conversation, outside the provider's scoped rows.
    const available =
      remaining - selected.reduce((sum, { itemId }) => sum + (forms.get(itemId)?.bytes ?? 0) + 1, 0)
    let bytes = 0
    for (const [id, form] of readJournalDomainClientForms(db, scope, linked)) {
      if (bytes + form.bytes < available) {
        items.set(id, form.item)
        bytes += form.bytes + 1
      }
    }
  }
  const before = selected.at(-1)?.sequence
  const hasEarlier =
    before !== undefined &&
    db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_turn_detail
    WHERE ${SCOPE} AND sequence<? LIMIT 1`)
      .get(...prefix, turnId, before)
  return {
    items: [...items.values()].sort(
      (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
    ),
    ...(hasEarlier ? { beforeSequence: before } : {})
  }
}

function legacyTurnItemId(scope: JournalSqlScope, operationId: string): string | undefined {
  const { snapshot } = readJournalDomainOperationWindow(scope, {
    operationIds: [operationId],
    anchorsOnly: true,
    throughAnchoredTurns: true,
    turnAttributionOnly: true
  })
  return indexBotGroupJournal(snapshot)(operationId).find((item) => item.body.kind === 'turn')
    ?.itemId
}
