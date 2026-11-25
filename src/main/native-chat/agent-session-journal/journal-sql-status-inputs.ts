import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import type { JournalSqlScope } from './journal-sql-scope'
import { journalDomainLatestSteerId } from './journal-domain-status-inputs'

const PAGE = 128

/** Drive related item/group metadata, never the historical submission payload population. */
export function* sqlStatusRelatedInputIds(
  scope: JournalSqlScope,
  start: number,
  floor: number
): Iterable<string> {
  let cursor = [floor, 0, -1]
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT i.sequence,i.sequence_index,i.ordinal,s.message_id
      FROM journal_items i LEFT JOIN journal_submission_attempts s
      ON s.session_id=i.session_id AND s.epoch=i.epoch AND s.current=1 AND s.item_id=i.item_id
      AND s.ordinal>=?
      WHERE i.session_id=? AND i.epoch=? AND i.hidden=0 AND i.prompt=1 AND i.sequence>?
      AND (i.sequence,i.sequence_index,i.ordinal)>(?,?,?)
      ORDER BY i.sequence,i.sequence_index,i.ordinal LIMIT ?`)
      .all(start, ...scope.prefix, floor, ...cursor, PAGE)
    for (const row of rows) {
      scope.examined(row)
      if (row.message_id !== null) {
        yield String(row.message_id)
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    cursor = [Number(last.sequence), Number(last.sequence_index), Number(last.ordinal)]
  }
  let after = ''
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT steer_turn_item_id FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id IS NOT NULL
      AND steer_turn_item_id>? GROUP BY steer_turn_item_id ORDER BY steer_turn_item_id LIMIT ?`)
      .all(...scope.prefix, after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const item = scope.db
        .prepare(`SELECT 1 FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
        .get(...scope.prefix, String(row.steer_turn_item_id))
      if (!item) {
        continue
      }
      scope.examined(item)
      const id = journalDomainLatestSteerId(scope, String(row.steer_turn_item_id))
      if (id !== undefined) {
        yield id
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return
    }
    after = String(last.steer_turn_item_id)
  }
}

function firstInputItem(item: AgentJournalRenderItem | null, floor: number): boolean {
  return !!(
    item &&
    item.sequence > floor &&
    item.body.kind === 'message' &&
    item.body.role === 'user' &&
    isRootAgentJournalItem(item) &&
    item.body.command === undefined
  )
}

/** Seeds retain provider fallback; historical associations contribute only their native item. */
export function readJournalSqlFirstInputId(
  state: JournalSqlStatusContext,
  start: number,
  floor: number,
  seeds: readonly AgentJournalSubmission[]
): string | null {
  const order = state
  const ids = new Set(seeds.map((entry) => entry.clientMessageId))
  for (const id of state.relatedInputIds(start, floor)) {
    ids.add(id)
  }
  const candidates = [...ids]
    .map((id) => ({ id, ordinal: order.inputOrdinal(id) }))
    .filter(({ ordinal }) => ordinal >= start)
    .sort((a, b) => a.ordinal - b.ordinal)
  for (const { id } of candidates) {
    const native = state.displayed(agentJournalSubmissionKey(id))
    const providerId = native ? undefined : state.submission(id)?.providerItemId
    const item = native ?? (providerId ? state.displayed(providerId) : null)
    if (firstInputItem(item, floor)) {
      return id
    }
  }
  return null
}
