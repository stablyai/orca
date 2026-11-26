// The withdrawal an owner's late reply would miss: Orca withdrew the question it names.
import {
  botItemAskWithdrawnOf,
  type BotItemAskWithdrawn
} from '../../shared/bots/bot-item-ask-while'
import type SyncDatabase from '../sqlite/sync-database'
import { eventRecordOf } from './bot-items-rows'

/** Why Orca withdrew the question, when the item's latest move did, after it. */
export function botItemWithdrawalAfter(
  db: SyncDatabase,
  uid: string,
  questionEventId: number
): BotItemAskWithdrawn | null {
  const row = db
    .prepare(
      `SELECT * FROM item_events WHERE item_uid = ? AND kind = 'status' ORDER BY id DESC LIMIT 1`
    )
    .get(uid)
  const event = row === undefined ? null : eventRecordOf(row)
  return event &&
    event.id > questionEventId &&
    event.actor.kind === 'orca' &&
    event.data.cause === 'withdrawn'
    ? botItemAskWithdrawnOf(event.data.withdrawn)
    : null
}
