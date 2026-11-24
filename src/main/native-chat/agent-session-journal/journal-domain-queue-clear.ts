import type Database from '../../sqlite/sync-database'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import { readJournalDomainQueueRow } from './journal-domain-queue-rows'
import {
  deriveQueuePauses,
  journalQueuePauseRestatement
} from './queued-messages/queued-message-pause'

type Target = { sessionId: string; epoch: string }

export type JournalDomainQueueClear = {
  sequence: number
  operationId: string
  messageIds: string[]
  lifted?: true
}

/** The clear restated over its still-held members; held members are a bounded queue subset. */
export function queueClearRestatement(
  db: Database.Database,
  target: Target
): Omit<JournalDomainQueueClear, 'sequence'> | null {
  const members = db
    .prepare(`SELECT card.message_id, card.revision, card.state, card.position, card.payload_json
      FROM journal_queue_clear_members member JOIN journal_queue_cards card
        ON card.session_id=member.session_id AND card.epoch=member.epoch AND card.message_id=member.message_id
      WHERE member.session_id=? AND member.epoch=?`)
    .all(target.sessionId, target.epoch)
    .map((row) => readJournalDomainQueueRow(target.sessionId, row).card)
  const context = readJournalDomainQueuePauseContext(
    db,
    target,
    null,
    members.map((card) => card.messageId)
  )
  const cleared = context.marks.cleared
  if (!cleared) {
    return null
  }
  const marks = {
    ...context.marks,
    cleared: { ...cleared, messageIds: [...context.clearMembers] }
  }
  const { cleared: restated } = journalQueuePauseRestatement(
    marks,
    context.latestAcceptedTurnSequence,
    deriveQueuePauses({ ...context, marks, cards: members }),
    context.latestPersonAcceptedTurnSequence
  )
  return restated ?? null
}

export function writeJournalDomainQueueClear(
  db: Database.Database,
  target: Target,
  sequence: number,
  clear: Omit<JournalDomainQueueClear, 'sequence'>
): JournalDomainQueueClear {
  const prefix = [target.sessionId, target.epoch] as const
  db.prepare(`UPDATE journal_chat_state SET queue_clear_sequence=?, queue_clear_operation_id=?,
    queue_clear_lifted=? WHERE session_id=? AND epoch=?`).run(
    sequence,
    clear.operationId,
    Number(clear.lifted === true),
    ...prefix
  )
  db.prepare('DELETE FROM journal_queue_clear_members WHERE session_id=? AND epoch=?').run(
    ...prefix
  )
  const insert =
    db.prepare(`INSERT OR IGNORE INTO journal_queue_clear_members(session_id,epoch,message_id)
    VALUES(?,?,?)`)
  for (const messageId of clear.messageIds) {
    insert.run(...prefix, messageId)
  }
  invalidateJournalDomainQueue(db, target, sequence)
  return { ...clear, messageIds: [...clear.messageIds], sequence }
}
