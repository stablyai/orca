import type Database from '../../../sqlite/sync-database'
import {
  hasProfileStateDocumentPartsTables,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS
} from './profile-state-document-parts'
import { PROFILE_STATE_DOCUMENT_PARTS_META_TABLE } from '../database/profile-state-database-schema'
import {
  authoritativeMeta,
  readLegacyRevision,
  readProfileStateSplitDocument
} from './profile-state-document-parts-storage'
import { withProfileStateWriteTransaction } from '../database/profile-state-write-transaction'

/**
 * Older builds read the legacy rows. Starting the writer and graceful close bring them current;
 * while it runs they lag the parts by at most this long, which bounds what a downgrade straight
 * after a crash can miss. A refresh rewrites each stale domain's whole document (several MB for
 * sessions), so a short interval would dominate profile-state disk writes.
 */
const LEGACY_DOCUMENT_REFRESH_INTERVAL_MS = 60 * 60 * 1000

type DatabaseSource = () => Database.Database | undefined

export class ProfileStateLegacyDocumentRefresh {
  private refreshedAt = Date.now()
  private caughtUp = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduled = false

  /**
   * The writer thread also refreshes on a timer through quiet periods; other authorities run
   * on threads that must not block on a refresh, so they only refresh around their own writes.
   */
  startWriterThread(db: Database.Database | undefined): void {
    this.scheduled = true
    this.catchUp(db)
  }

  /** A crash skips the close-time refresh; catch older builds up once before writing on. */
  catchUp(db: Database.Database | undefined): void {
    if (!this.caughtUp) {
      this.caughtUp = true
      this.refresh(db)
    }
  }

  beforeClose(db: Database.Database | undefined, graceful: boolean | undefined): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (graceful) {
      this.refresh(db)
    }
  }

  afterWrite(source: DatabaseSource): void {
    const remaining = this.refreshedAt + LEGACY_DOCUMENT_REFRESH_INTERVAL_MS - Date.now()
    if (remaining <= 0) {
      this.refresh(source())
    } else if (this.scheduled && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.refresh(source())
      }, remaining)
      this.timer.unref?.()
    }
  }

  /** Best effort: a failed refresh rolls back, leaving older builds a staler copy, never a wrong one. */
  refresh(db: Database.Database | undefined): void {
    // An open transaction means a write is unsettled; the next refresh will catch up.
    if (!db || db.isTransaction) {
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.refreshedAt = Date.now()
    try {
      refreshStaleProfileStateLegacyDocuments(db)
    } catch (error) {
      console.warn('[profile-state] Failed to refresh legacy documents:', error)
    }
  }
}

/** Throws on failure; the transaction leaves legacy rows as they were. */
export function refreshStaleProfileStateLegacyDocuments(db: Database.Database): void {
  // Most checks find nothing stale; skip the write transaction entirely then.
  if (staleLegacyDomains(db).length > 0) {
    withProfileStateWriteTransaction(db, () => refreshProfileStateLegacyDocuments(db))
  }
}

function staleLegacyDomains(db: Database.Database): { domain: string; legacyRevision: number }[] {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return []
  }
  const stale: { domain: string; legacyRevision: number }[] = []
  for (const domain of PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()) {
    const legacyRevision = readLegacyRevision(db, domain)
    if (legacyRevision === null) {
      continue
    }
    const meta = authoritativeMeta(db, domain, legacyRevision)
    if (meta && meta.revision !== legacyRevision) {
      stale.push({ domain, legacyRevision })
    }
  }
  return stale
}

/**
 * Bring stale legacy rows up to date so an older build (or a downgrade) reads current
 * state. The profile revision does not move: the logical content is unchanged.
 */
function refreshProfileStateLegacyDocuments(db: Database.Database): void {
  for (const { domain, legacyRevision } of staleLegacyDomains(db)) {
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
  }
}
