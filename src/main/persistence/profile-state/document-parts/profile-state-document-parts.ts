import type Database from '../../../sqlite/sync-database'
import { isRecord } from '../documents/profile-state-document-validation'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'

/**
 * Large map-shaped domains are stored as one row per entry so a save rewrites only the
 * entries that changed. Readers reassemble the exact original JSON, so everything above
 * this layer still sees one document per domain.
 *
 * Older builds ignore these tables and read the domain's legacy `profile_state_documents`
 * row. That row is refreshed from the parts when the writer starts, at most hourly while it
 * runs, and at graceful close; when an older build rewrites it, its revision no longer matches
 * `legacy_revision` and the legacy row becomes authoritative again until the next write
 * re-splits it.
 */
import {
  createProfileStateDocumentPartsTablesSql,
  PROFILE_STATE_DOCUMENT_PARTS_META_TABLE,
  PROFILE_STATE_DOCUMENT_PARTS_TABLE
} from '../database/profile-state-database-schema'

const [LOCAL_SESSION_DOMAIN, HOST_SESSION_DOMAIN] = WORKSPACE_SESSION_DOMAINS

/** Object nesting levels split into rows; arrays and scalars are always leaves. */
export const PROFILE_STATE_SPLIT_DOMAIN_DEPTHS: ReadonlyMap<string, number> = new Map([
  // host → session field → tab/worktree/pane entry
  [HOST_SESSION_DOMAIN, 3],
  // session field → tab/worktree/pane entry
  [LOCAL_SESSION_DOMAIN, 2],
  // environment → { workspaces } → worktree
  ['remoteLayoutSnapshots', 3],
  ['worktreeMeta', 1],
  ['worktreeMetaByIdentity', 1],
  ['worktreeIdentityAliases', 1]
])

export function isProfileStateSplitDomain(domain: string): boolean {
  return PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.has(domain)
}

export type ProfileStateDocumentPart = {
  /** JSON array of the object keys leading to this value. */
  key: string
  payload: string
}

/** Depth-first parts whose concatenation reproduces JSON.stringify(value) exactly. */
export function splitProfileStateDomainValue(
  value: unknown,
  depth: number
): ProfileStateDocumentPart[] {
  const parts: ProfileStateDocumentPart[] = []
  const visit = (current: unknown, path: string[], remaining: number): void => {
    if (remaining > 0 && isRecord(current) && typeof current.toJSON !== 'function') {
      // JSON.stringify drops undefined/function/symbol members; the parts must match it.
      const children = Object.entries(current).filter(
        ([, child]) =>
          child !== undefined && typeof child !== 'function' && typeof child !== 'symbol'
      )
      if (children.length > 0) {
        for (const [key, child] of children) {
          visit(child, [...path, key], remaining - 1)
        }
        return
      }
    }
    const payload = JSON.stringify(current)
    if (payload !== undefined) {
      parts.push({ key: JSON.stringify(path), payload })
    }
  }
  visit(value, [], depth)
  return parts
}

/** Inverse of split: rebuild the document text from depth-first ordered parts. */
export function assembleProfileStateDomainPayload(
  parts: readonly ProfileStateDocumentPart[]
): string {
  let out = ''
  let open: string[] = []
  let first = true
  for (const part of parts) {
    const path = parsePartKey(part.key)
    let common = 0
    while (common < open.length && common < path.length - 1 && open[common] === path[common]) {
      common++
    }
    for (let i = open.length; i > common; i--) {
      out += '}'
    }
    open = open.slice(0, common)
    if (!first) {
      out += ','
    }
    for (let i = common; i < path.length - 1; i++) {
      out += `${JSON.stringify(path[i])}:{`
      open.push(path[i]!)
    }
    if (path.length > 0) {
      out += `${JSON.stringify(path.at(-1))}:`
    }
    out += part.payload
    first = false
  }
  out += '}'.repeat(open.length)
  if (parts.length === 0) {
    return '{}'
  }
  return parts.length === 1 && parsePartKey(parts[0]!.key).length === 0 ? out : `{${out}}`
}

function parsePartKey(key: string): string[] {
  const path: unknown = JSON.parse(key)
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === 'string')) {
    throw new Error('Profile state document part key is invalid')
  }
  return path
}

const partsTablesByDatabase = new WeakMap<Database.Database, boolean>()

/** Read-only and pre-split databases may not have the tables; treat them as unsplit. */
export function hasProfileStateDocumentPartsTables(db: Database.Database): boolean {
  const cached = partsTablesByDatabase.get(db)
  if (cached !== undefined) {
    return cached
  }
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)`)
    .all(PROFILE_STATE_DOCUMENT_PARTS_TABLE, PROFILE_STATE_DOCUMENT_PARTS_META_TABLE)
  const present = rows.length === 2
  // Only cache presence: a writable open may create the tables after a negative probe.
  if (present) {
    partsTablesByDatabase.set(db, true)
  }
  return present
}

export function ensureProfileStateDocumentPartsTables(db: Database.Database): void {
  db.exec(createProfileStateDocumentPartsTablesSql())
  partsTablesByDatabase.set(db, true)
}
