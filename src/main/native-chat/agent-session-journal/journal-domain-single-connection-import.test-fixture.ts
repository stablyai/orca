import type Database from '../../sqlite/sync-database'
import { prepareJournalDomainImport } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from './journal-domain-import-rows'

/**
 * Imports one chat's frozen source on a single connection, for callers without a reader pool:
 * the same restore, typed pages and ready-last head the background import writes across batches.
 * The source is read before the writer transaction opens, never inside it.
 */
export function convertJournalSqlProjection(
  db: Database.Database,
  sessionId: string
): string | null {
  const prepared = prepareJournalDomainImport(db, sessionId)
  if (!prepared) {
    return null
  }
  const { pages, ...header } = prepared
  const all = [...pages]
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const page of all) {
      insertJournalDomainImportPage(db, header, page)
    }
    const epoch = finishJournalDomainImport(db, header)
    db.exec('COMMIT')
    return epoch
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
