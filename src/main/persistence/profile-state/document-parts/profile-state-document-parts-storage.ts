import type Database from '../../../sqlite/sync-database'
import {
  assembleProfileStateDomainPayload,
  hasProfileStateDocumentPartsTables,
  isProfileStateSplitDomain,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS,
  splitProfileStateDomainValue
} from './profile-state-document-parts'
import {
  hashProfileStatePayload as hashProfileStatePart,
  hashProfileStatePayload,
  isRecord,
  ProfileStateDocumentCorruptionError,
  type ProfileStateDocument
} from '../documents/profile-state-document-validation'
import {
  PROFILE_STATE_DOCUMENT_PARTS_META_TABLE,
  PROFILE_STATE_DOCUMENT_PARTS_TABLE
} from '../database/profile-state-database-schema'
import type { ProfileStateDocumentPart } from './profile-state-document-parts'
import {
  readStoredPartRows,
  writeProfileStatePartRows,
  type StoredPartRow
} from './profile-state-part-rows'

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

/** Reassembled document for a split domain, or undefined when its legacy row is authoritative. */
export function readProfileStateSplitDocument(
  db: Database.Database,
  domain: string,
  legacyRevision: number
): ProfileStateDocument | undefined {
  if (!isProfileStateSplitDomain(domain)) {
    return undefined
  }
  const meta = authoritativeMeta(db, domain, legacyRevision)
  if (!meta) {
    return undefined
  }
  const rows = db
    .prepare(
      `SELECT part_key, payload, content_hash FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
       WHERE domain = ? ORDER BY ordinal`
    )
    .iterate(domain)
  const parts: ProfileStateDocumentPart[] = []
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.part_key !== 'string' ||
      typeof row.payload !== 'string' ||
      row.content_hash !== hashProfileStatePart(row.payload)
    ) {
      throw new ProfileStateDocumentCorruptionError(
        `Profile state document part is invalid: ${domain}`,
        domain
      )
    }
    parts.push({ key: row.part_key, payload: row.payload })
  }
  let payload: string
  try {
    payload = assembleProfileStateDomainPayload(parts)
  } catch {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document parts are invalid: ${domain}`,
      domain
    )
  }
  if (hashProfileStatePayload(payload) !== meta.contentHash) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document parts hash mismatch: ${domain}`,
      domain
    )
  }
  return {
    domain,
    payload,
    domainVersion: meta.domainVersion,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    contentHash: meta.contentHash
  }
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

export function deleteProfileStateDomainParts(db: Database.Database, domain: string): void {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return
  }
  db.prepare(`DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} WHERE domain = ?`).run(domain)
  db.prepare(`DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE} WHERE domain = ?`).run(domain)
}

export function clearProfileStateDocumentParts(db: Database.Database): void {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return
  }
  db.exec(`DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE};
    DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE};`)
}

/** What a split write stored, so the writer can patch it next without reading it back. */
export type StoredProfileStateDomainParts = {
  parts: readonly ProfileStateDocumentPart[]
  hashes: readonly string[]
  rows: Map<string, StoredPartRow>
}

/**
 * Write only the parts whose content or position changed. Returns undefined when the payload
 * cannot be split losslessly; the caller then stores it as an ordinary legacy row.
 */
export function writeProfileStateDomainParts(
  db: Database.Database,
  args: {
    domain: string
    payload: string
    /** Already-parsed payload, when the caller has it. */
    value?: unknown
    payloadHash: string
    domainVersion: number
    revision: number
    updatedAt: number
    /** Legacy row revision after this write; parts stay authoritative only while it matches. */
    legacyRevision: number
    /** Existing parts are a valid base to diff against. */
    diffExisting: boolean
  }
): StoredProfileStateDomainParts | undefined {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return undefined
  }
  const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(args.domain)
  if (depth === undefined) {
    return undefined
  }
  const parts = splitProfileStateDomainValue(
    args.value === undefined ? JSON.parse(args.payload) : args.value,
    depth
  )
  // Non-canonical JSON (whitespace, escapes) would not round-trip byte-for-byte.
  if (assembleProfileStateDomainPayload(parts) !== args.payload) {
    deleteProfileStateDomainParts(db, args.domain)
    return undefined
  }
  if (!args.diffExisting) {
    db.prepare(`DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} WHERE domain = ?`).run(
      args.domain
    )
  }
  const hashes = parts.map(({ payload }) => hashProfileStatePart(payload))
  const rows = writeProfileStatePartRows(
    db,
    args.domain,
    parts.map((part, index) => ({ ...part, hash: hashes[index]! })),
    args.diffExisting ? readStoredPartRows(db, args.domain) : new Map(),
    {
      domainVersion: args.domainVersion,
      revision: args.revision,
      updatedAt: args.updatedAt,
      contentHash: args.payloadHash,
      legacyRevision: args.legacyRevision
    }
  )
  return { parts, hashes, rows }
}
