import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import { PROFILE_STATE_DOCUMENT_PARTS_TABLE } from '../database/profile-state-database-schema'
import {
  hashProfileStatePayload,
  isRecord,
  ProfileStateDocumentCorruptionError
} from '../documents/profile-state-document-validation'
import {
  emitProfileStateDomainPayload,
  type ProfileStateDocumentPathPart
} from './profile-state-document-parts'
import {
  partsLeaf,
  partsTreeFromStoredParts,
  partsTreeParts,
  type PartsNode
} from './profile-state-parts-tree'
import {
  writeProfileStateDomainParts,
  type StoredPartRow,
  type StoredProfileStateDomainParts
} from './profile-state-document-parts-storage'

/** A split domain as the writer last committed it: the tree to patch and the rows it is stored as. */
export type CommittedPartsTree = {
  root: PartsNode
  rows: Map<string, StoredPartRow>
  contentHash: string
  /** The meta row's revision; another writer can restore the same content with different rows. */
  revision: number
  legacyRevision: number
}

function parsePath(key: string, domain: string): string[] {
  let path: unknown
  try {
    path = JSON.parse(key)
  } catch {
    path = undefined
  }
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === 'string')) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document part key is invalid: ${domain}`,
      domain
    )
  }
  return path
}

function hashPathParts(parts: Iterable<ProfileStateDocumentPathPart>): string {
  const hash = createHash('sha256')
  emitProfileStateDomainPayload(parts, (piece) => hash.update(piece, 'utf8'))
  return hash.digest('hex')
}

/** sha256 of the document the tree stores, streamed so the whole text is never built. */
export function hashPartsTree(root: PartsNode): string {
  return hashPathParts(partsTreeParts(root))
}

/** The tree for parts this writer just stored whole, so the next patch needs no read. */
export function partsTreeFromWrittenParts(
  domain: string,
  written: StoredProfileStateDomainParts
): PartsNode {
  return partsTreeFromStoredParts(
    written.parts.map((part) => ({
      path: parsePath(part.key, domain),
      leaf: partsLeaf(part.payload, part.hash)
    }))
  )
}

/** Loads authoritative parts into a tree, checking each row and the whole document's hash. */
export function readCommittedPartsTree(
  db: Database.Database,
  domain: string,
  stored: { contentHash: string; revision: number; legacyRevision: number }
): CommittedPartsTree {
  const rows = new Map<string, StoredPartRow>()
  const parts: { path: string[]; leaf: ReturnType<typeof partsLeaf> }[] = []
  for (const row of db
    .prepare(
      `SELECT part_key, ordinal, payload, content_hash FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE}
       WHERE domain = ? ORDER BY ordinal`
    )
    .iterate(domain)) {
    if (
      !isRecord(row) ||
      typeof row.part_key !== 'string' ||
      typeof row.payload !== 'string' ||
      row.content_hash !== hashProfileStatePayload(row.payload)
    ) {
      throw new ProfileStateDocumentCorruptionError(
        `Profile state document part is invalid: ${domain}`,
        domain
      )
    }
    rows.set(row.part_key, { ordinal: Number(row.ordinal), hash: row.content_hash })
    parts.push({
      path: parsePath(row.part_key, domain),
      leaf: partsLeaf(row.payload, row.content_hash)
    })
  }
  // Hash in stored order, as readers assemble it; the tree would re-sort integer-like keys.
  if (
    hashPathParts(parts.map(({ path, leaf }) => ({ path, payload: leaf.payload }))) !==
    stored.contentHash
  ) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document parts hash mismatch: ${domain}`,
      domain
    )
  }
  return {
    root: partsTreeFromStoredParts(parts),
    rows,
    contentHash: stored.contentHash,
    revision: stored.revision,
    legacyRevision: stored.legacyRevision
  }
}

/** Stores a patched tree, writing only the rows whose content or position changed. */
export function writeCommittedPartsTree(
  db: Database.Database,
  domain: string,
  previous: CommittedPartsTree,
  root: PartsNode,
  meta: {
    domainVersion: number
    revision: number
    updatedAt: number
    contentHash: string
    legacyRevision: number
  }
): CommittedPartsTree {
  const written = writeProfileStateDomainParts(db, {
    domain,
    payloadHash: meta.contentHash,
    domainVersion: meta.domainVersion,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    legacyRevision: meta.legacyRevision,
    hashedParts: [...partsTreeParts(root)],
    storedRows: previous.rows
  })
  if (!written) {
    throw new Error(`Profile state parts are not writable: ${domain}`)
  }
  return {
    root,
    rows: written.rows,
    contentHash: meta.contentHash,
    revision: meta.revision,
    legacyRevision: meta.legacyRevision
  }
}
