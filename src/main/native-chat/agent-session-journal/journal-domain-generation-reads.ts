import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isHistoricalProviderTimelineItem } from '../agent-session-timeline/provider-timeline-history'
import {
  journalDomainLatestStop,
  journalDomainStopDecidesTurn
} from './journal-domain-item-normalization'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalStopSettleFact } from './journal-writer-host-facts'

/** Select current lifecycle obligations and their named turn/opener evidence, in render order. */
export function readJournalDomainGeneration(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  startKey: string | undefined,
  stopSettle?: JournalStopSettleFact,
  exitScope?: { completedAt: number; ownerFence: number }
) {
  const prefix = [target.sessionId, target.epoch] as const
  const selected = new Map<
    string,
    { item: AgentJournalRenderItem; ordinal: number; fence: number | undefined }
  >()
  const include = (row: Record<string, unknown>) => {
    const item: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
    selected.set(item.itemId, {
      item,
      ordinal: Number(row.ordinal),
      fence: row.fence == null ? undefined : Number(row.fence)
    })
    return item
  }
  const point = (key: string): AgentJournalRenderItem | null => {
    const known = selected.get(key)
    if (known) {
      return known.item
    }
    const row = db
      .prepare(`SELECT payload_json,ordinal,COALESCE(execution_owner,owner_fence) AS fence
      FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=COALESCE(
        (SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
      .get(...prefix, ...prefix, key, key)
    return row ? include(row) : null
  }
  const dependencies = (item: AgentJournalRenderItem) => {
    const parent = item.turnScope?.kind === 'turn' ? point(item.turnScope.turnItemId) : null
    for (const turnItem of [item, parent]) {
      const opener = readAgentJournalTurn(turnItem?.body)?.userItemId
      if (opener) {
        point(opener)
      }
    }
  }
  for (const [index, predicate] of [
    [
      'journal_items_unsettled',
      `hidden=0 AND (lifecycle_state IN ('running','pending') OR live_work=1)`
    ],
    [
      'journal_items_unverifiable_turn',
      `hidden=0 AND kind IN ('turn','status') AND lifecycle_state='unverifiable'`
    ],
    ['journal_items_unverified_end', `hidden=0 AND unverified_end=1`]
  ]) {
    let after: [number, string] | undefined
    for (;;) {
      const rows = db
        .prepare(`SELECT payload_json,ordinal,item_id,COALESCE(execution_owner,owner_fence) AS fence
        FROM journal_items INDEXED BY ${index} WHERE session_id=? AND epoch=? AND ${predicate}
        ${after ? 'AND (ordinal,item_id)>(?,?)' : ''} ORDER BY ordinal,item_id LIMIT 128`)
        .all(...prefix, ...(after ?? []))
      for (const row of rows) {
        include(row)
      }
      if (rows.length < 128) {
        break
      }
      const last = rows.at(-1)!
      after = [Number(last.ordinal), String(last.item_id)]
    }
  }
  for (const { item } of selected.values()) {
    dependencies(item)
  }
  if (exitScope) {
    let after: [number, number, number, string] | undefined
    let found = false
    for (;;) {
      const rows = db
        .prepare(`SELECT payload_json,ordinal,item_id,sequence,sequence_index,COALESCE(execution_owner,owner_fence) AS fence
        FROM journal_items INDEXED BY journal_items_interrupted_root WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND kind IN ('turn','status')
        AND lifecycle_state='interrupted' AND turn_completed_at IS NOT NULL AND turn_completed_at=?
        ${after ? 'AND (sequence,sequence_index,ordinal,item_id)<(?,?,?,?)' : ''}
        ORDER BY sequence DESC,sequence_index DESC,ordinal DESC,item_id DESC LIMIT 128`)
        .all(...prefix, exitScope.completedAt, ...(after ?? []))
      for (const row of rows) {
        const fence = row.fence == null ? undefined : Number(row.fence)
        if (fence !== undefined && fence < exitScope.ownerFence) {
          continue
        }
        const item = include(row)
        dependencies(item)
        if (!isHistoricalProviderTimelineItem(item, point)) {
          found = true
          break
        }
      }
      if (found || rows.length < 128) {
        break
      }
      const last = rows.at(-1)!
      after = [
        Number(last.sequence),
        Number(last.sequence_index),
        Number(last.ordinal),
        String(last.item_id)
      ]
    }
  }
  if (startKey !== undefined) {
    point(agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey)))
  }
  const items = [...selected.values()]
    .sort(
      (a, b) =>
        a.item.sequence - b.item.sequence ||
        (a.item.sequenceIndex ?? 0) - (b.item.sequenceIndex ?? 0) ||
        a.ordinal - b.ordinal
    )
    .map((row) => row.item)
  const submissions: AgentJournalSubmission[] = []
  let afterSend: [number, string] | undefined
  for (;;) {
    const rows = db
      .prepare(`SELECT payload_json,ordinal,message_id FROM journal_submission_attempts INDEXED BY journal_submission_recovery
      WHERE session_id=? AND epoch=? AND current=1 AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))
      ${afterSend ? 'AND (ordinal,message_id)>(?,?)' : ''} ORDER BY ordinal,message_id LIMIT 128`)
      .all(...prefix, ...(afterSend ?? []))
    for (const row of rows) {
      submissions.push(JSON.parse(String(row.payload_json)))
    }
    if (rows.length < 128) {
      break
    }
    const last = rows.at(-1)!
    afterSend = [Number(last.ordinal), String(last.message_id)]
  }
  return {
    statusRead: () => ({ items, submissions: [] }),
    snapshot: () => ({
      items,
      submissions: [],
      sessionId: target.sessionId,
      cursor: journalDomainContextHead(db, target)
    }),
    inputOrder: { recoverableSubmissions: () => submissions },
    submissions: () => submissions,
    submission: (messageId: string) =>
      submissions.find((send) => send.clientMessageId === messageId),
    itemBody: (key: string) => point(key)?.body ?? null,
    itemFence: (key: string) => {
      point(key)
      return selected.get(key)?.fence
    },
    stopMarks: {
      latest: () => journalDomainLatestStop(db, target, stopSettle),
      personStopDecides: (turnId: string | null, endedAt?: number) =>
        journalDomainStopDecidesTurn(
          journalDomainLatestStop(db, target, stopSettle),
          turnId,
          endedAt
        )
    },
    lastProviderActivityAt: (fence: number): number | undefined => {
      const row = db
        .prepare(
          `SELECT last_activity_at FROM journal_provider_activity WHERE session_id=? AND epoch=? AND fence=?`
        )
        .get(...prefix, fence)
      return row ? Number(row.last_activity_at) : undefined
    },
    cursor: () => journalDomainContextHead(db, target)
  }
}
