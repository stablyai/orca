import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import { withProfileStateReadSnapshot } from './profile-state-read-snapshot'
import type Database from '../../sqlite/sync-database'
import { readCurrentAutomationRunsState } from './profile-state-automation-runs-storage'
import {
  PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE,
  PROFILE_STATE_DOCUMENT_VERSION,
  PROFILE_STATE_META_REVISION
} from './profile-state-database-schema'
import {
  hashProfileStatePayload,
  parseProfileStateRoot,
  ProfileStateDocumentCorruptionError,
  ProfileStateRevisionConflictError,
  type ProfileStateDocument
} from './profile-state-document-validation'
import {
  clearProfileStateAutomationRuns,
  rebuildProfileStateAutomationRunsProjection
} from './profile-state-automation-runs'

import { readProfileStateDocuments } from './profile-state-document-reader'

import { readProfileStateRevision } from './profile-state-revision'
import { readProfileStateJsonAcceptance } from './profile-state-json-acceptance'

export {
  acceptProfileStateJsonCompatibility,
  readProfileStateJsonAcceptance,
  stageProfileStateJsonCompatibility,
  type ProfileStateJsonAcceptance
} from './profile-state-json-acceptance'

export { readProfileStateRevision } from './profile-state-revision'
export { readProfileStateDocuments } from './profile-state-document-reader'
export type { ReadProfileStateDocumentsOptions } from './profile-state-document-reader'
export { ProfileStateDocumentCorruptionError, ProfileStateRevisionConflictError }
export type { ProfileStateDocument } from './profile-state-document-validation'

export type ImportProfileStateOptions = {
  now?: () => number
  /** Hash of the exact legacy JSON bytes accepted by this import. */
  acceptedLegacyJsonHash?: string
  /** Revision observed by the caller before constructing this replacement. */
  expectedRevision?: number
}

export type ProfileStateSnapshot = {
  revision: number
  documents: readonly ProfileStateDocument[]
  json: string
}

export type ProfileStateParsedSnapshot = {
  revision: number
  state: Record<string, unknown>
}

/** Import a complete JSON document set atomically into one profile database. */
export function importProfileStateJson(
  db: Database.Database,
  rawJson: string,
  options: ImportProfileStateOptions = {}
): number {
  const parsed = parseProfileStateRoot(rawJson)
  const entries = Object.entries(parsed).map(([domain, value]) => {
    const payload = JSON.stringify(value)
    if (payload === undefined) {
      throw new ProfileStateDocumentCorruptionError(
        `Profile state domain cannot be serialized: ${domain}`,
        domain
      )
    }
    return { domain, payload }
  })

  const now = options.now ?? Date.now
  if (
    options.acceptedLegacyJsonHash !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.acceptedLegacyJsonHash)
  ) {
    throw new ProfileStateDocumentCorruptionError('Legacy JSON acceptance hash is invalid')
  }
  if (
    options.expectedRevision !== undefined &&
    (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)
  ) {
    throw new ProfileStateDocumentCorruptionError('Expected profile state revision is invalid')
  }
  const updatedAt = now()
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new ProfileStateDocumentCorruptionError('Profile state update timestamp is invalid')
  }
  return withProfileStateWriteTransaction(db, () => {
    const actualRevision = readProfileStateRevision(db)
    if (options.expectedRevision !== undefined && actualRevision !== options.expectedRevision) {
      throw new ProfileStateRevisionConflictError(options.expectedRevision, actualRevision)
    }
    readCurrentAutomationRunsState(db, actualRevision)
    const revision = actualRevision + 1
    clearProfileStateAutomationRuns(db)
    db.exec('DELETE FROM profile_state_documents')
    const automationRuns = entries.find((entry) => entry.domain === 'automationRuns')
    const normalizedRuns =
      automationRuns !== undefined &&
      rebuildProfileStateAutomationRunsProjection(
        db,
        automationRuns.payload,
        PROFILE_STATE_DOCUMENT_VERSION,
        updatedAt,
        revision
      )
    const insert = db.prepare(
      `INSERT INTO profile_state_documents
       (domain, payload, domain_version, revision, updated_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const entry of entries) {
      const payload = normalizedRuns && entry.domain === 'automationRuns' ? 'null' : entry.payload
      insert.run(
        entry.domain,
        payload,
        PROFILE_STATE_DOCUMENT_VERSION,
        revision,
        updatedAt,
        hashProfileStatePayload(payload)
      )
    }
    db.prepare(
      `INSERT INTO profile_state_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(PROFILE_STATE_META_REVISION, String(revision))
    if (options.acceptedLegacyJsonHash !== undefined) {
      db.prepare(
        `INSERT INTO profile_state_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(
        PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE,
        JSON.stringify({ jsonHash: options.acceptedLegacyJsonHash, acceptedRevision: revision })
      )
    }
    return revision
  })
}

export function hashProfileStateJson(rawJson: string): string {
  return hashProfileStatePayload(rawJson)
}

/** Validate that retained legacy JSON is the exact export accepted by this database. */
export function profileStateJsonMatchesAcceptance(db: Database.Database, rawJson: string): boolean {
  return readAcceptedProfileStateSnapshot(db, rawJson) !== undefined
}

/** Validate the retained JSON and return the same database snapshot used for acceptance. */
export function readAcceptedProfileStateSnapshot(
  db: Database.Database,
  rawJson: string
): ProfileStateSnapshot | undefined {
  return readAcceptedSnapshot(db, rawJson, () => readProfileStateSnapshot(db))
}

export function readAcceptedProfileStateParsedSnapshot(
  db: Database.Database,
  rawJson: string
): ProfileStateParsedSnapshot | undefined {
  return readAcceptedSnapshot(db, rawJson, () => readProfileStateParsedSnapshot(db))
}

function readAcceptedSnapshot<T extends { revision: number }>(
  db: Database.Database,
  rawJson: string,
  read: () => T
): T | undefined {
  return withProfileStateReadSnapshot(db, () => {
    const marker = readProfileStateJsonAcceptance(db)
    const snapshot = read()
    const jsonHash = hashProfileStateJson(rawJson)
    return marker !== undefined &&
      (marker.jsonHash === jsonHash || marker.pending?.jsonHash === jsonHash) &&
      snapshot.revision >= (marker.pending?.acceptedRevision ?? marker.acceptedRevision)
      ? snapshot
      : undefined
  })
}

/** Transfer independently validated values without constructing another whole-profile string. */
export function readProfileStateParsedSnapshot(db: Database.Database): ProfileStateParsedSnapshot {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    const documents = readProfileStateDocuments(db, {
      profileRevision: revision,
      representation: 'parsed'
    })
    return {
      revision,
      state: Object.fromEntries(documents.map((document) => [document.domain, document.value]))
    }
  })
}

/** Export the row set as JSON accepted by the current loader. */
export function exportProfileStateJson(db: Database.Database): string {
  return readProfileStateSnapshot(db).json
}

/** Read revision, rows, and their JSON projection under one SQLite snapshot. */
export function readProfileStateSnapshot(db: Database.Database): ProfileStateSnapshot {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    const documents = readProfileStateDocuments(db, { profileRevision: revision })
    return {
      revision,
      documents,
      // Every payload was already hash- and JSON-validated above. Reusing the
      // validated fragments avoids parsing and stringifying the full profile a
      // second time before Store parses it at its domain boundary.
      json: `{${documents
        .map((document) => `${JSON.stringify(document.domain)}:${document.payload}`)
        .join(',')}}`
    }
  })
}

/** Validate the complete snapshot without retaining state that recovery callers discard. */
export function validateProfileStateSnapshot(db: Database.Database): number {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    readProfileStateDocuments(db, { profileRevision: revision, representation: 'validated' })
    return revision
  })
}
