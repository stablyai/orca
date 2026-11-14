import type Database from '../../../sqlite/sync-database'
import {
  assembleProfileStateDomainPayload,
  hasProfileStateDocumentPartsTables,
  isProfileStateSplitDomain,
  parsePartKey,
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
import { assignProfileStatePartOrdinals } from './profile-state-document-part-ordinals'
import { authoritativeMeta } from './profile-state-document-parts-metadata'
export {
  authoritativeMeta,
  readLegacyRevision,
  readSplitDomainWriteState,
  safeInteger
} from './profile-state-document-parts-metadata'

export type ProfileStateExistingDocumentParts = Map<
  string,
  { ordinal: number; contentHash: string; payload?: string; path?: readonly string[] }
>

export type ProfileStatePreparedDocumentPart = ProfileStateDocumentPart & {
  contentHash: string
  ordinal: number
}

/** Reassembled document for a split domain, or undefined when its legacy row is authoritative. */
export function readProfileStateSplitDocument(
  db: Database.Database,
  domain: string,
  legacyRevision: number,
  retainedParts?: ProfileStateExistingDocumentParts
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
      `SELECT part_key, ordinal, payload, content_hash FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
       WHERE domain = ? ORDER BY ordinal`
    )
    .iterate(domain)
  const parts: ProfileStateDocumentPart[] = []
  const paths: string[][] = []
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
    let path: string[]
    try {
      path = parsePartKey(row.part_key)
    } catch {
      throw new ProfileStateDocumentCorruptionError(
        `Profile state document parts are invalid: ${domain}`,
        domain
      )
    }
    parts.push({ key: row.part_key, payload: row.payload })
    paths.push(path)
    retainedParts?.set(row.part_key, {
      ordinal: Number(row.ordinal),
      contentHash: String(row.content_hash),
      payload: row.payload,
      path
    })
  }
  let payload: string
  try {
    payload = assembleProfileStateDomainPayload(parts, paths)
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

/**
 * Write only the parts whose content or position changed. Returns false when the payload
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
    existingParts?: ProfileStateExistingDocumentParts
    preparedParts?: readonly ProfileStatePreparedDocumentPart[]
  }
): boolean {
  if (!hasProfileStateDocumentPartsTables(db)) {
    return false
  }
  const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(args.domain)
  if (depth === undefined) {
    return false
  }
  const parts =
    args.preparedParts ??
    splitProfileStateDomainValue(
      args.value === undefined ? JSON.parse(args.payload) : args.value,
      depth
    )
  // Non-canonical JSON (whitespace, escapes) would not round-trip byte-for-byte.
  if (!args.preparedParts && assembleProfileStateDomainPayload(parts) !== args.payload) {
    deleteProfileStateDomainParts(db, args.domain)
    return false
  }
  const existing =
    args.existingParts ??
    new Map<string, { ordinal: number; contentHash: string; payload?: string }>()
  if (args.diffExisting && args.existingParts === undefined) {
    for (const row of db
      .prepare(
        `SELECT part_key, ordinal, content_hash FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
         WHERE domain = ?`
      )
      .iterate(args.domain)) {
      if (isRecord(row) && typeof row.part_key === 'string') {
        existing.set(row.part_key, {
          ordinal: Number(row.ordinal),
          contentHash: String(row.content_hash)
        })
      }
    }
  } else if (!args.diffExisting) {
    db.prepare(`DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} WHERE domain = ?`).run(
      args.domain
    )
  }
  const ordinals =
    args.preparedParts?.map(({ ordinal }) => ordinal) ??
    assignProfileStatePartOrdinals(
      parts.map(({ key }) => key),
      new Map([...existing].map(([key, { ordinal }]) => [key, ordinal]))
    )
  const insert = db.prepare(
    `INSERT INTO ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
     (domain, part_key, ordinal, payload, content_hash) VALUES (?, ?, ?, ?, ?)`
  )
  const updatePayload = db.prepare(
    `UPDATE ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} SET ordinal = ?, payload = ?, content_hash = ?
     WHERE domain = ? AND part_key = ?`
  )
  const updateOrdinal = db.prepare(
    `UPDATE ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} SET ordinal = ? WHERE domain = ? AND part_key = ?`
  )
  const remove = db.prepare(
    `DELETE FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} WHERE domain = ? AND part_key = ?`
  )
  const seen = new Set<string>()
  parts.forEach((part, index) => {
    seen.add(part.key)
    const ordinal = ordinals[index]!
    const previous = existing.get(part.key)
    const contentHash =
      'contentHash' in part ? String(part.contentHash) : hashProfileStatePart(part.payload)
    if (!previous) {
      insert.run(args.domain, part.key, ordinal, part.payload, contentHash)
    } else if (previous.contentHash !== contentHash) {
      updatePayload.run(ordinal, part.payload, contentHash, args.domain, part.key)
    } else if (previous.ordinal !== ordinal) {
      updateOrdinal.run(ordinal, args.domain, part.key)
    }
  })
  for (const key of existing.keys()) {
    if (!seen.has(key)) {
      remove.run(args.domain, key)
    }
  }
  db.prepare(
    `INSERT INTO ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE}
     (domain, domain_version, revision, updated_at, content_hash, legacy_revision)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       domain_version = excluded.domain_version,
       revision = excluded.revision,
       updated_at = excluded.updated_at,
       content_hash = excluded.content_hash,
       legacy_revision = excluded.legacy_revision`
  ).run(
    args.domain,
    args.domainVersion,
    args.revision,
    args.updatedAt,
    args.payloadHash,
    args.legacyRevision
  )
  return true
}
