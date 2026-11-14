import type Database from '../../../sqlite/sync-database'
import {
  hasProfileStateDocumentPartsTables,
  isProfileStateSplitDomain
} from './profile-state-document-parts'
import { PROFILE_STATE_DOCUMENT_PARTS_META_TABLE } from '../database/profile-state-database-schema'
import {
  isRecord,
  ProfileStateDocumentCorruptionError
} from '../documents/profile-state-document-validation'

type PartsMeta = {
  domainVersion: number
  revision: number
  updatedAt: number
  contentHash: string
  legacyRevision: number | null
}

function readPartsMeta(db: Database.Database, domain: string): PartsMeta | undefined {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return undefined
  }
  const row = db
    .prepare(
      `SELECT domain_version, revision, updated_at, content_hash, legacy_revision
       FROM ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE} WHERE domain = ?`
    )
    .get(domain)
  if (row === undefined) {
    return undefined
  }
  const domainVersion = isRecord(row) ? safeInteger(row.domain_version) : undefined
  const revision = isRecord(row) ? safeInteger(row.revision) : undefined
  const updatedAt = isRecord(row) ? safeInteger(row.updated_at) : undefined
  const legacyRevision = isRecord(row) ? safeInteger(row.legacy_revision) : undefined
  if (
    !isRecord(row) ||
    // Same bounds as an ordinary document row, which this metadata stands in for.
    domainVersion === undefined ||
    domainVersion < 1 ||
    revision === undefined ||
    revision < 1 ||
    updatedAt === undefined ||
    updatedAt < 0 ||
    typeof row.content_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.content_hash) ||
    (row.legacy_revision !== null && (legacyRevision === undefined || legacyRevision < 1))
  ) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document parts metadata is invalid: ${domain}`,
      domain
    )
  }
  return {
    domainVersion,
    revision,
    updatedAt,
    contentHash: row.content_hash,
    legacyRevision: legacyRevision ?? null
  }
}

export function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

export function readLegacyRevision(db: Database.Database, domain: string): number | null {
  const row = db
    .prepare('SELECT revision FROM profile_state_documents WHERE domain = ?')
    .get(domain)
  return (isRecord(row) ? safeInteger(row.revision) : undefined) ?? null
}

/** Parts win only while the legacy row is the one this layout last synced. */
export function authoritativeMeta(
  db: Database.Database,
  domain: string,
  legacyRevision: number | null
): PartsMeta | undefined {
  const meta = readPartsMeta(db, domain)
  return meta !== undefined && legacyRevision !== null && meta.legacyRevision === legacyRevision
    ? meta
    : undefined
}

export type SplitDomainWriteState =
  | { kind: 'unsplit' }
  | { kind: 'parts'; legacyRevision: number; contentHash: string; revision: number }

/** Lets the writer compare by hash without reading or re-validating a stale legacy payload. */
export function readSplitDomainWriteState(
  db: Database.Database,
  domain: string
): SplitDomainWriteState {
  if (!isProfileStateSplitDomain(domain)) {
    return { kind: 'unsplit' }
  }
  const legacyRevision = readLegacyRevision(db, domain)
  const meta = authoritativeMeta(db, domain, legacyRevision)
  return meta && legacyRevision !== null
    ? { kind: 'parts', legacyRevision, contentHash: meta.contentHash, revision: meta.revision }
    : { kind: 'unsplit' }
}
