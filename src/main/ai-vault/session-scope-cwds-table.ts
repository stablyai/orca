// The scope_cwds table of the session parse cache database: a transcript
// version's cwd learned without a parse, read beside each parse row's own cwd.
import type SyncDatabase from '../sqlite/sync-database'
import { parsePersistedSidecar } from './session-sidecar-stat'
import type { SessionScopeCwdLookup, SessionScopeCwdStamp } from './session-parse-cache-store'

// A transcript's cwd learned without a parse (its opening records, or a small
// file its parser reads it from). Versioned apart from rows, so a reader fix
// resets only these.
const SCOPE_CWDS_VERSION = '1'
const SCOPE_CWDS_SQL = `
CREATE TABLE IF NOT EXISTS scope_cwds(
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  platform TEXT NOT NULL,
  sidecar TEXT,
  cwd TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scope_cwds_seen_at ON scope_cwds(seen_at);
`
// Keeps each IN list well under SQLite's bound-parameter limit.
const SCOPE_LOOKUP_CHUNK = 500
const VALID_SESSION =
  "CASE WHEN json_valid(session) THEN json_type(session) IN ('object','null') ELSE 0 END"

export function readScopeCwdRows(
  db: SyncDatabase,
  paths: readonly string[],
  channel: 'parsed' | 'read'
): Map<string, SessionScopeCwdLookup> {
  const found = new Map<string, SessionScopeCwdLookup>()
  for (let start = 0; start < paths.length; start += SCOPE_LOOKUP_CHUNK) {
    const chunk = paths.slice(start, start + SCOPE_LOOKUP_CHUNK)
    const marks = chunk.map(() => '?').join(',')
    for (const [table, key, cwdColumn] of [
      ['rows', 'parsed', `CASE WHEN ${VALID_SESSION} THEN json_extract(session, '$.cwd') END`],
      ['scope_cwds', 'read', 'cwd']
    ] as const) {
      if (key !== channel) {
        continue
      }
      const rows = db
        .prepare(
          `SELECT path, mtime_ms, size_bytes, platform, sidecar, ${cwdColumn} AS cwd FROM ${table} WHERE path IN (${marks}) ${key === 'parsed' ? `AND (${VALID_SESSION})` : ''}`
        )
        .all(...chunk)
      for (const row of rows) {
        const stamp = parseScopeCwdStamp(row)
        if (stamp && typeof row.path === 'string') {
          found.set(row.path, { ...found.get(row.path), [key]: stamp })
        }
      }
    }
  }
  return found
}

export function writeScopeCwdRows(
  db: SyncDatabase,
  rows: Iterable<[string, SessionScopeCwdStamp]>,
  seenAt: number
): void {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO scope_cwds(path, mtime_ms, size_bytes, platform, sidecar, cwd, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [path, stamp] of rows) {
      insert.run(
        path,
        stamp.mtimeMs,
        stamp.sizeBytes,
        stamp.platform,
        stamp.sidecar === undefined ? null : JSON.stringify(stamp.sidecar),
        stamp.cwd,
        seenAt
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}

export function ensureScopeCwdsTable(db: SyncDatabase): void {
  const current = db.prepare("SELECT value FROM meta WHERE key = 'scope_cwds_version'").get()
  if (current?.value !== SCOPE_CWDS_VERSION) {
    db.exec('DROP TABLE IF EXISTS scope_cwds')
  }
  db.exec(SCOPE_CWDS_SQL)
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('scope_cwds_version', ?)").run(
    SCOPE_CWDS_VERSION
  )
}

function parseScopeCwdStamp(row: Record<string, unknown>): SessionScopeCwdStamp | null {
  const { mtime_ms: mtimeMs, size_bytes: sizeBytes, platform, cwd } = row
  if (
    typeof mtimeMs !== 'number' ||
    (sizeBytes !== null && typeof sizeBytes !== 'number') ||
    typeof platform !== 'string' ||
    (cwd !== null && typeof cwd !== 'string')
  ) {
    return null
  }
  let sidecar: ReturnType<typeof parsePersistedSidecar>
  try {
    sidecar =
      typeof row.sidecar === 'string' ? parsePersistedSidecar(JSON.parse(row.sidecar)) : undefined
  } catch {
    return null
  }
  return {
    mtimeMs,
    sizeBytes,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only ever compared for equality with process.platform, so an unknown value is a miss, not a misuse.
    platform: platform as NodeJS.Platform,
    cwd,
    ...(sidecar === undefined ? {} : { sidecar })
  }
}
