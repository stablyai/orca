import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

/** Claims the stored chat attachments a message written to this journal names, in the write's own
 *  transaction; `required` refuses the whole write when one is no longer stored, except one the
 *  `previous` body it replaces already named. */
export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem
) => void
