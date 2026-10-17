import { AUTOMATION_RUNS_DOMAIN } from './profile-state-automation-runs-model'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { readProfileStateRevision } from './profile-state-revision'
import {
  validateProfileStateDocumentRow,
  type ProfileStateDocument
} from './profile-state-document-validation'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

export type SalvageDocumentSource = {
  databasePath: string
  profileId: string
  /** Keep only these domains when set. */
  domains?: readonly string[]
}

export type SalvageResult = {
  /** Documents whose stored hash and metadata verify. */
  intactDocuments: readonly ProfileStateDocument[]
  /**
   * Documents dropped because they reference normalized storage (automation
   * runs kept in projection tables) whose rows are not verifiable byte-for-byte
   * by a hash check.
   */
  droppedProjectionDomains: readonly string[]
  /** Domains whose row failed validation and were skipped. */
  skippedDomains: readonly string[]
  /** The salvaged database's own profile revision, if readable. */
  sourceRevision: number
}

/**
 * Recover the individually intact documents from a profile-state database that
 * fails whole-snapshot validation.
 *
 * Whole-snapshot readers fail closed on the first corrupt row, so a crash or
 * torn write that leaves one document's `content_hash` stale blocks recovery of
 * every other document in the file. This reads the rows one at a time and keeps
 * only the ones whose hash and metadata still verify, so a caller can merge
 * them into a clean baseline and recover the lost revisions.
 */
export function salvageValidDocuments(options: SalvageDocumentSource): SalvageResult {
  const opened = openProfileStateDatabaseReadOnly(options.databasePath, options.profileId)
  try {
    const sourceRevision = readProfileStateRevision(opened.db)
    const wanted = options.domains !== undefined ? new Set(options.domains) : undefined
    const intactDocuments: ProfileStateDocument[] = []
    const droppedProjectionDomains: string[] = []
    const skippedDomains: string[] = []
    for (const row of opened.db
      .prepare(
        `SELECT domain, payload, domain_version, revision, updated_at, content_hash
         FROM profile_state_documents ORDER BY rowid`
      )
      .iterate() as unknown as Iterable<SqliteRow>) {
      const domain = row.domain
      if (wanted !== undefined && (typeof domain !== 'string' || !wanted.has(domain))) {
        continue
      }
      try {
        // Validate hash and metadata; skip JSON parsing because the original
        // writer stored a well-formed payload and the caller merges by byte.
        const document = validateProfileStateDocumentRow(row, { validateJson: false })
        if (domain === AUTOMATION_RUNS_DOMAIN) {
          // Normalized automation runs live in projection tables whose aggregate
          // hash this row cannot verify byte-for-byte; a document-row-only merge
          // would orphan the restored baseline. Drop the domain and let the
          // caller recover it from a trusted snapshot.
          droppedProjectionDomains.push(domain)
          continue
        }
        intactDocuments.push(document)
      } catch {
        if (typeof domain === 'string') {
          skippedDomains.push(domain)
        }
      }
    }
    return {
      intactDocuments,
      droppedProjectionDomains,
      skippedDomains,
      sourceRevision
    }
  } finally {
    opened.db.close()
  }
}
