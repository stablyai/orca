import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

/** Claim attachments atomically; required rejects missing uploads except references retained from previous. */
export type JournalAttachmentClaim = (
  db: Database.Database,
  body: AgentJournalMessageItem,
  required: boolean,
  previous?: AgentJournalMessageItem
) => void
