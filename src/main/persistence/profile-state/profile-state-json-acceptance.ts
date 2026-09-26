import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import type Database from '../../sqlite/sync-database'
import { PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE } from './profile-state-database-schema'
import {
  hashProfileStatePayload,
  isRecord,
  parseProfileStateRoot,
  ProfileStateDocumentCorruptionError,
  ProfileStateRevisionConflictError
} from './profile-state-document-validation'
import { readProfileStateRevision } from './profile-state-revision'

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

/** Accept either side of the upcoming JSON replacement before publishing it. */
export function stageProfileStateJsonCompatibility(
  db: Database.Database,
  rawJson: string,
  expectedRevision: number,
  retainedJson?: string
): void {
  const retainedHash =
    retainedJson === undefined ? undefined : hashProfileStatePayload(retainedJson)
  updateProfileStateJsonAcceptance(db, rawJson, expectedRevision, (previous, next) => {
    if (previous === undefined) {
      return next
    }
    const retained =
      retainedHash === undefined || retainedHash === previous.jsonHash
        ? previous
        : previous.pending?.jsonHash === retainedHash
          ? previous.pending
          : undefined
    if (retained === undefined) {
      throw new ProfileStateDocumentCorruptionError('Compatibility JSON changed before export')
    }
    return {
      jsonHash: retained.jsonHash,
      acceptedRevision: retained.acceptedRevision,
      pending: next
    }
  })
}

/** Promote the staged JSON after publication; failures leave both versions accepted. */
export function acceptProfileStateJsonCompatibility(
  db: Database.Database,
  rawJson: string,
  expectedRevision: number
): void {
  updateProfileStateJsonAcceptance(db, rawJson, expectedRevision, (previous, next) => {
    const staged = previous?.pending ?? previous
    if (staged?.jsonHash !== next.jsonHash || staged.acceptedRevision !== next.acceptedRevision) {
      throw new ProfileStateDocumentCorruptionError('Compatibility JSON export was not staged')
    }
    return next
  })
}

function updateProfileStateJsonAcceptance(
  db: Database.Database,
  rawJson: string,
  expectedRevision: number,
  update: (
    previous: ProfileStateJsonAcceptance | undefined,
    next: ProfileStateJsonAcceptanceVersion
  ) => ProfileStateJsonAcceptance
): void {
  parseProfileStateRoot(rawJson)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ProfileStateDocumentCorruptionError(
      'Compatibility JSON acceptance revision is invalid'
    )
  }
  return withProfileStateWriteTransaction(db, () => {
    const actualRevision = readProfileStateRevision(db)
    if (actualRevision !== expectedRevision) {
      throw new ProfileStateRevisionConflictError(expectedRevision, actualRevision)
    }
    const previous = readProfileStateJsonAcceptance(db)
    if (
      previous &&
      (previous.pending?.acceptedRevision ?? previous.acceptedRevision) > actualRevision
    ) {
      throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance marker is invalid')
    }
    const marker = update(previous, {
      jsonHash: hashProfileStatePayload(rawJson),
      acceptedRevision: expectedRevision
    })
    db.prepare(
      `INSERT INTO profile_state_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE, JSON.stringify(marker))
  })
}
