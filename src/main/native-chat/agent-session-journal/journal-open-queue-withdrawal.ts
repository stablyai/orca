import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readJournalDomainQueueRow } from './journal-domain-queue-rows'
import { readCommandReceipt } from './writing/command-receipt-table'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'

/** Derived restart work is replaced by the new owner, while ordinary queued work retains custody. */
export function withdrawOpeningDerivedQueue(
  db: Database.Database,
  stateDirectory: string,
  target: { sessionId: string; epoch: string },
  openedThrough: AgentJournalCursor,
  savedAt: number
): void {
  let after: [number, string] | undefined
  for (;;) {
    const rows = db
      .prepare(`SELECT position,message_id,state,revision,payload_json FROM journal_queue_cards
      INDEXED BY journal_queue_order WHERE session_id=? AND epoch=? AND state IN ('waiting','returned')
      ${after ? 'AND (position,message_id)>(?,?)' : ''}
      ORDER BY position,message_id LIMIT 64`)
      .all(target.sessionId, target.epoch, ...(after ?? []))
    const ids: string[] = []
    for (const row of rows) {
      const { card } = readJournalDomainQueueRow(target.sessionId, row)
      if (
        card.queuedAt?.epoch === openedThrough.epoch &&
        card.queuedAt.sequence > openedThrough.sequence
      ) {
        continue
      }
      const receipt = readCommandReceipt(db, { kind: 'global' }, card.messageId)
      if (
        (card.body.from?.orchestration?.message === 'task' && card.deliveryMode === 'steer') ||
        (receipt.verdict === 'readable' &&
          receipt.receipt.callerKey === 'trusted-local:restart-continuation')
      ) {
        ids.push(card.messageId)
      }
    }
    if (ids.length > 0) {
      applyJournalDomainQueueCommand(
        db,
        stateDirectory,
        target,
        { kind: 'queue-withdraw', messageIds: ids },
        savedAt
      )
    }
    if (rows.length < 64) {
      return
    }
    const last = rows.at(-1)!
    after = [Number(last.position), String(last.message_id)]
  }
}
