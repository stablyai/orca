import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { readSessionSearchFileRows } from './session-search-file-rows'
import { fileIdentity, PARTIAL_FILE_CURSOR } from './storage/session-search-file-cursor'
import type { SessionSearchFileRow } from './storage/session-search-store-types'

export type SessionSearchWorkAdmission = {
  file: SessionSearchFileRow | undefined
  work: Record<string, unknown> | undefined
}

export function projectSessionSearchWorkAdmission(db: SyncDatabase, paths: string[]) {
  const files = new Map(
    readSessionSearchFileRows(db, undefined, undefined, paths).map((row) => [row.path, row])
  )
  const work = new Map(
    db
      .prepare(`SELECT path,fact_id,fact_revision,version,force_read,metadata,lane,rank,ordering,due,deferred
    FROM temp.search_read_work WHERE path IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(paths))
      .map((row) => [String(row.path), row])
  )
  return new Map(paths.map((path) => [path, { file: files.get(path), work: work.get(path) }]))
}

export function projectSessionSearchAdmissionMetadata(db: SyncDatabase, paths: string[]) {
  return new Map(
    db
      .prepare(`SELECT key,value FROM temp.search_catalog
    WHERE scope='discovery-metadata' AND key IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(paths))
      .map((row) => [String(row.key), { key: String(row.key), value: String(row.value) }])
  )
}

export function sessionSearchProjectedCursor(
  candidate: SessionFileCandidate,
  row: SessionSearchFileRow | undefined
) {
  if (!row) {
    return null
  }
  const identity = fileIdentity(candidate.file)
  if (
    identity &&
    row.identity &&
    (identity.dev !== row.identity.dev || identity.ino !== row.identity.ino)
  ) {
    return null
  }
  return {
    byteOffset: row.byteOffset === PARTIAL_FILE_CURSOR ? null : (row.byteOffset ?? null),
    mtimeMs: row.mtimeMs,
    sizeBytes: row.sizeBytes
  }
}
