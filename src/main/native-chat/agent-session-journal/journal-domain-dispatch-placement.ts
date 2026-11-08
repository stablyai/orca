import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import type { JournalDomainSubmissionTarget } from './journal-domain-submission-records'

export type JournalDomainDispatchItem = {
  item: AgentJournalRenderItem
  ordinal: number
  hidden: boolean
  ownerFence: number
  executionOwner: number | null
}

export function readJournalDomainDispatchItem(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  itemId: string
): JournalDomainDispatchItem | null {
  const row = db
    .prepare(`SELECT payload_json,ordinal,hidden,owner_fence,execution_owner
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(target.sessionId, target.epoch, itemId)
  return row
    ? {
        item: JSON.parse(String(row.payload_json)),
        ordinal: Number(row.ordinal),
        hidden: Boolean(row.hidden),
        ownerFence: Number(row.owner_fence),
        executionOwner: row.execution_owner === null ? null : Number(row.execution_owner)
      }
    : null
}

/** Dispatch moves retain the accepted body's revision and ordinal, unlike ordinary content writes. */
export function placeJournalDomainDispatchItem(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  previous: JournalDomainDispatchItem,
  place: { sequence: number; observedAt: number; turnScope?: AgentJournalTurnScope } | null,
  hidden: boolean
): AgentJournalRenderItem[] {
  if (!place && previous.hidden === hidden) {
    return []
  }
  const { sequenceIndex: _priorPlacement, ...item } = previous.item
  return writeJournalDomainCurrentItem(db, target, {
    item: place ? { ...item, ...place } : previous.item,
    previous,
    ordinal: previous.ordinal,
    hidden,
    ownerFence: previous.ownerFence,
    executionOwner: previous.executionOwner
  })
}
