import type Database from '../../sqlite/sync-database'
import { PROFILE_STATE_META_REVISION } from './profile-state-database-schema'
import { isRecord, ProfileStateDocumentCorruptionError } from './profile-state-document-validation'

export function readProfileStateRevision(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM profile_state_meta WHERE key = ?')
    .get(PROFILE_STATE_META_REVISION)
  if (!isRecord(row) || typeof row.value !== 'string') {
    return 0
  }
  const revision = Number(row.value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ProfileStateDocumentCorruptionError('Profile state revision is invalid')
  }
  return revision
}

/** Unchanged domains may lag the profile revision, but cannot lead it. */
export function assertProfileStateDocumentRevision(
  revision: number,
  profileRevision: number,
  domain: string
): void {
  if (revision > profileRevision) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document revision ${revision} exceeds profile revision ${profileRevision}`,
      domain
    )
  }
}

/**
 * Advance the shared profile revision to a floor. `writeProfileStateDomains`
 * rejects rows whose revision exceeds the profile revision, so merging salvaged
 * rows into a restored baseline must move the profile revision up to the floor.
 *
 * Rows are not versioned per document, so they are bumped to the floor too —
 * a row at or below the floor already satisfies the revision fence, but moving
 * every row keeps the invariant "row revision <= profile revision" aligned in
 * one step. The automation-runs metadata table is left untouched because its
 * DOCUMENT marker pins revision to 0 and must not be advanced;
 * `profile_state_meta` is the profile revision itself.
 */
export function raiseProfileStateRevisionFloor(
  db: Database.Database,
  floorRevision: number
): void {
  if (!Number.isSafeInteger(floorRevision) || floorRevision < 0) {
    throw new ProfileStateDocumentCorruptionError('Profile state revision floor is invalid')
  }
  // Bump only rows that lead the floor. A row at or below it is already
  // consistent with the new profile revision.
  db
    .prepare(`UPDATE profile_state_documents SET revision = ? WHERE revision < ?`)
    .run(floorRevision, floorRevision)
  // Automation-runs normalized rows may also lead the floor; keep them fenced.
  // The DOCUMENT storage marker pins revision 0 by invariant, so exclude it.
  db
    .prepare(
      `UPDATE profile_state_automation_runs_meta
       SET revision = ? WHERE revision < ? AND presence <> 'document'`
    )
    .run(floorRevision, floorRevision)
  db
    .prepare(`INSERT OR REPLACE INTO profile_state_meta (key, value) VALUES (?, ?)`)
    .run(PROFILE_STATE_META_REVISION, String(floorRevision))
}
