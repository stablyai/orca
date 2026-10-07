import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalRowTransactionHook } from './journal-row-writer'
import type { JournalSubmissionConsume, JournalSubmissionInput } from './journal-store-contracts'

/** Claims the stored chat attachments a message written to this journal names, in the write's own
 *  transaction; `required` refuses the whole write when one is no longer stored. */
export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean
) => void

/** The submission append's hook, inside its transaction: converts the draft it hands off, if any,
 *  and claims the stored attachments it names. A client's new message must name only attachments
 *  still stored; a draft's conversion was claimed when the draft was written. */
export function journalSubmissionHook(
  queuedMessages: JournalQueuedMessages,
  claimAttachments: JournalAttachmentClaim,
  input: Pick<JournalSubmissionInput, 'clientMessageId' | 'body' | 'origin'>,
  consume: JournalSubmissionConsume | undefined
): JournalRowTransactionHook {
  return (db) => {
    if (consume) {
      queuedMessages.consumeInTransaction(db, { ...consume, consumedAs: input.clientMessageId })
    }
    claimAttachments(db, input.body, input.origin === 'client' && !consume)
  }
}
