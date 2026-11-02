import type Database from '../../sqlite/sync-database'
import {
  readProfileStateRevision,
  assertProfileStateDocumentRevision
} from './profile-state-revision'
import { readProfileStateAutomationRunsDocument } from './profile-state-automation-runs-reader'
import {
  ProfileStateDocumentCorruptionError,
  validateProfileStateDocumentRow
} from './profile-state-document-validation'
import {
  markAutomationRunsDocumentStorage,
  compactAutomationRunsDocument
} from './profile-state-automation-runs-storage'

export function migrateAutomationRunsStorage(db: Database.Database, storedVersion: number): void {
  if (storedVersion < 2) {
    markAutomationRunsDocumentStorage(db)
  } else {
    const meta = db
      .prepare('SELECT domain FROM profile_state_automation_runs_meta WHERE domain = ?')
      .get('automationRuns')
    if (meta === undefined) {
      // Schema 2 cannot distinguish cleared history from a lost projection marker.
      if (
        readProfileStateRevision(db) !== 0 ||
        db.prepare('SELECT 1 FROM profile_state_documents LIMIT 1').get() !== undefined ||
        db.prepare('SELECT 1 FROM profile_state_automation_runs LIMIT 1').get() !== undefined
      ) {
        throw new ProfileStateDocumentCorruptionError(
          'Schema 2 automationRuns storage is ambiguous; restore a validated backup or JSON export',
          'automationRuns'
        )
      }
      markAutomationRunsDocumentStorage(db)
    }
  }
  const revision = readProfileStateRevision(db)
  for (const row of db.prepare('SELECT * FROM profile_state_documents').all()) {
    const document = validateProfileStateDocumentRow(row)
    assertProfileStateDocumentRevision(document.revision, revision, document.domain)
  }
  if (readProfileStateAutomationRunsDocument(db, revision) !== undefined) {
    compactAutomationRunsDocument(db)
  }
}
