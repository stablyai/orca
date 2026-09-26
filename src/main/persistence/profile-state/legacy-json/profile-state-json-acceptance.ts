import type Database from '../../../sqlite/sync-database'
import { PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE } from '../profile-state-database-schema'
import { isRecord, ProfileStateDocumentCorruptionError } from '../profile-state-document-validation'

type ProfileStateJsonAcceptanceVersion = {
  jsonHash: string
  acceptedRevision: number
}

export type ProfileStateJsonAcceptance = ProfileStateJsonAcceptanceVersion & {
  pending?: ProfileStateJsonAcceptanceVersion
}

/** Read the source acceptance marker, if this database has one. */
export function readProfileStateJsonAcceptance(
  db: Database.Database
): ProfileStateJsonAcceptance | undefined {
  const row = db
    .prepare('SELECT value FROM profile_state_meta WHERE key = ?')
    .get(PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE)
  if (row === undefined) {
    return undefined
  }
  if (!isRecord(row) || typeof row.value !== 'string') {
    throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance marker is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance marker is invalid')
  }
  if (!isJsonAcceptanceVersion(parsed)) {
    throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance marker is invalid')
  }
  let pending: ProfileStateJsonAcceptanceVersion | undefined
  if ('pending' in parsed) {
    if (
      !isJsonAcceptanceVersion(parsed.pending) ||
      parsed.pending.acceptedRevision < parsed.acceptedRevision
    ) {
      throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance marker is invalid')
    }
    pending = parsed.pending
  }
  return {
    jsonHash: parsed.jsonHash,
    acceptedRevision: parsed.acceptedRevision,
    ...(pending === undefined ? {} : { pending })
  }
}

function isJsonAcceptanceVersion(value: unknown): value is ProfileStateJsonAcceptanceVersion {
  return (
    isRecord(value) &&
    typeof value.jsonHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.jsonHash) &&
    typeof value.acceptedRevision === 'number' &&
    Number.isSafeInteger(value.acceptedRevision) &&
    value.acceptedRevision >= 1
  )
}
