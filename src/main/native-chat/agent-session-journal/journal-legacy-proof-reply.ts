import type Database from '../../sqlite/sync-database'
import {
  JournalLegacyRetentionError,
  readJournalLegacySource
} from './journal-legacy-retention-error'
import { readJournalLegacyProofPage, type LegacyProofCursor } from './journal-legacy-source-proof'
import type { JournalSqlReaderReply } from './journal-sql-reader-protocol'

/** One proof page from the reader; a refusal comes back as a page that names it. */
export function legacyProofReply(
  openOriginal: () => Database.Database | undefined,
  db: Database.Database,
  id: number,
  cursor: LegacyProofCursor
): Extract<JournalSqlReaderReply, { type: 'legacy-proof' }> {
  try {
    const source = readJournalLegacySource(openOriginal)
    if (!source) {
      throw new Error('legacy source disappeared during proof')
    }
    return { type: 'legacy-proof', id, page: readJournalLegacyProofPage(source, cursor, db) }
  } catch (error) {
    if (!(error instanceof JournalLegacyRetentionError)) {
      throw error
    }
    const page = { next: null, sessions: [], retained: error.message, reason: error.reason }
    return { type: 'legacy-proof', id, page }
  }
}
