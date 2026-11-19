import type Database from '../../../sqlite/sync-database'
import {
  PROFILE_STATE_DOCUMENT_PARTS_META_TABLE,
  PROFILE_STATE_DOCUMENT_PARTS_TABLE
} from '../database/profile-state-database-schema'
import { isRecord } from '../documents/profile-state-document-validation'
import { assignProfileStatePartOrdinals } from './profile-state-document-part-ordinals'

/** A stored part row as the writer last committed it. */
export type StoredPartRow = { ordinal: number; hash: string }

export type PartsMetaWrite = {
  domainVersion: number
  revision: number
  updatedAt: number
  contentHash: string
  legacyRevision: number
}

export function readStoredPartRows(
  db: Database.Database,
  domain: string
): Map<string, StoredPartRow> {
  const rows = new Map<string, StoredPartRow>()
  for (const row of db
    .prepare(
      `SELECT part_key, ordinal, content_hash FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
       WHERE domain = ?`
    )
    .iterate(domain)) {
    if (isRecord(row) && typeof row.part_key === 'string') {
      rows.set(row.part_key, { ordinal: Number(row.ordinal), hash: String(row.content_hash) })
    }
  }
  return rows
}

/**
 * Writes only the rows whose content or position changed against `existing`, then the meta row.
 * Returns the rows as stored afterwards.
 */
export function writeProfileStatePartRows(
  db: Database.Database,
  domain: string,
  parts: readonly { key: string; payload: string; hash: string }[],
  existing: ReadonlyMap<string, StoredPartRow>,
  meta: PartsMetaWrite
): Map<string, StoredPartRow> {
  const ordinals = assignProfileStatePartOrdinals(
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
  const stored = new Map<string, StoredPartRow>()
  parts.forEach((part, index) => {
    const ordinal = ordinals[index]!
    const previous = existing.get(part.key)
    if (!previous) {
      insert.run(domain, part.key, ordinal, part.payload, part.hash)
    } else if (previous.hash !== part.hash) {
      updatePayload.run(ordinal, part.payload, part.hash, domain, part.key)
    } else if (previous.ordinal !== ordinal) {
      updateOrdinal.run(ordinal, domain, part.key)
    }
    stored.set(part.key, { ordinal, hash: part.hash })
  })
  for (const key of existing.keys()) {
    if (!stored.has(key)) {
      remove.run(domain, key)
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
    domain,
    meta.domainVersion,
    meta.revision,
    meta.updatedAt,
    meta.contentHash,
    meta.legacyRevision
  )
  return stored
}
