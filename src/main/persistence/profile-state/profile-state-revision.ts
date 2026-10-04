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
