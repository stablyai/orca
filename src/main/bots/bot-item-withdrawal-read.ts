// The withdrawal an owner's late reply would miss: Orca withdrew the question it names.
import {
  botItemAskWithdrawnOf,
  type BotItemAskWithdrawn
} from '../../shared/bots/bot-item-ask-while'
import type SyncDatabase from '../sqlite/sync-database'
import { eventRecordOf } from './bot-items-rows'

/** Why Orca withdrew the question a late reply names, when it did. */
export function botItemWithdrawalAfter(
  db: SyncDatabase,
  uid: string,
  questionEventId: number
): BotItemAskWithdrawn | null {
  const row = db
    .prepare(
      `SELECT * FROM item_events WHERE item_uid = ? AND id > ? AND kind = 'status'
         AND json_extract(actor, '$.kind') = 'orca' AND json_extract(data, '$.cause') = 'withdrawn'
         AND EXISTS (SELECT 1 FROM json_each(data, '$.asked') WHERE value = ?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(uid, questionEventId, questionEventId)
  return row === undefined ? null : botItemAskWithdrawnOf(eventRecordOf(row).data.withdrawn)
}
