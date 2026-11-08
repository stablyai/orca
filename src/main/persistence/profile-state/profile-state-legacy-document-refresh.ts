import type Database from '../../sqlite/sync-database'
import {
  hasProfileStateDocumentPartsTables,
  PROFILE_STATE_DOCUMENT_PARTS_META_TABLE,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS
} from './profile-state-document-parts'
import {
  authoritativeMeta,
  readLegacyRevision,
  readProfileStateSplitDocument
} from './profile-state-document-parts-storage'
import { withProfileStateWriteTransaction } from './profile-state-write-transaction'

/** Older builds read the legacy rows; keep them at most this stale while running. */
const LEGACY_DOCUMENT_REFRESH_INTERVAL_MS = 60 * 60 * 1000

export class ProfileStateLegacyDocumentRefresh {
  private refreshedAt = Date.now()

  refreshIfDue(db: Database.Database | undefined): void {
    if (Date.now() - this.refreshedAt >= LEGACY_DOCUMENT_REFRESH_INTERVAL_MS) {
      this.refresh(db)
    }
  }

  /** Best effort: a failed refresh rolls back, leaving older builds a staler copy, never a wrong one. */
  refresh(db: Database.Database | undefined): void {
    // An open transaction means a write is unsettled; the next refresh will catch up.
    if (!db || db.isTransaction) {
      return
    }
    this.refreshedAt = Date.now()
    try {
      withProfileStateWriteTransaction(db, () => refreshProfileStateLegacyDocuments(db))
    } catch (error) {
      console.warn('[profile-state] Failed to refresh legacy documents:', error)
    }
  }
}

/**
 * Bring stale legacy rows up to date so an older build (or a downgrade) reads current
 * state. The profile revision does not move: the logical content is unchanged.
 */
export function refreshProfileStateLegacyDocuments(db: Database.Database): number {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return 0
  }
  let refreshed = 0
  for (const domain of Object.keys(PROFILE_STATE_SPLIT_DOMAIN_DEPTHS)) {
    const legacyRevision = readLegacyRevision(db, domain)
    if (legacyRevision === null) {
      continue
    }
    const meta = authoritativeMeta(db, domain, legacyRevision)
    if (!meta || meta.revision === legacyRevision) {
      continue
    }
    const document = readProfileStateSplitDocument(db, domain, legacyRevision)
    if (!document) {
      continue
    }
    db.prepare(
      `UPDATE profile_state_documents
       SET payload = ?, domain_version = ?, revision = ?, updated_at = ?, content_hash = ?
       WHERE domain = ?`
    ).run(
      document.payload,
      document.domainVersion,
      document.revision,
      document.updatedAt,
      document.contentHash,
      domain
    )
    db.prepare(
      `UPDATE ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE} SET legacy_revision = ? WHERE domain = ?`
    ).run(document.revision, domain)
    refreshed++
  }
  return refreshed
}
