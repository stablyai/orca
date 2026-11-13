import { asRecord } from '../ai-vault/parsing/session-record-fields'
import type SyncDatabase from '../sqlite/sync-database'
import type {
  SessionSearchStateCounts,
  SessionSearchFileRow
} from './storage/session-search-store-types'
import { boundedSessionSearchPage } from './session-search-catalog-pages'

export function readSessionSearchFileRows(
  db: SyncDatabase,
  path?: string,
  after?: string
): SessionSearchFileRow[] {
  const statement = db.prepare(
    // Numeric stat IDs may exceed SQLite's safe INTEGER-to-number read range.
    `SELECT f.path, f.byte_offset AS byteOffset, f.prefix_hash AS prefixHash, s.agent, CAST(f.dev AS REAL) AS dev, CAST(f.ino AS REAL) AS ino,
                  mtime_ms AS mtimeMs, size_bytes AS sizeBytes,
                  state, fail_count AS failCount, failed_mtime_ms AS failedMtimeMs
           FROM files f LEFT JOIN sessions s ON s.id=f.session_row_id${path !== undefined ? ' WHERE f.path = ?' : after !== undefined ? ' WHERE f.path > ? ORDER BY f.path LIMIT 256' : ''}`
  )
  type Row = Omit<SessionSearchFileRow, 'identity'> & {
    dev: number | null
    ino: number | null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected fields above match this internal row projection.
  const rows = statement.iterate(
    ...(path !== undefined ? [path] : after !== undefined ? [after] : [])
  ) as Iterable<Row>
  const decode = (row: Row): SessionSearchFileRow => ({
    path: row.path,
    byteOffset: row.byteOffset,
    prefixHash: row.prefixHash,
    agent: row.agent,
    identity:
      typeof row.dev === 'number' && typeof row.ino === 'number'
        ? { dev: row.dev, ino: row.ino }
        : null,
    mtimeMs: row.mtimeMs,
    sizeBytes: row.sizeBytes,
    state: row.state,
    failCount: row.failCount,
    failedMtimeMs: row.failedMtimeMs
  })
  return after === undefined ? Array.from(rows, decode) : boundedSessionSearchPage(rows, decode)
}
/** Count session headers without reading their messages. */
export function sessionSearchSessionsByAgent(db: SyncDatabase): Record<string, number> {
  const rows = db.prepare('SELECT agent, count(*) AS n FROM sessions GROUP BY agent').all()
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const agent = asRecord(row)?.agent
    const total = asRecord(row)?.n
    if (typeof agent === 'string' && typeof total === 'number') {
      counts[agent] = total
    }
  }
  return counts
}

export function* iterateSessionSearchFileRows(
  db: SyncDatabase
): IterableIterator<SessionSearchFileRow> {
  let after = ''
  while (true) {
    const page = readSessionSearchFileRows(db, undefined, after)
    if (!page.length) {
      return
    }
    yield* page
    after = page.at(-1)!.path
  }
}

export function readSessionSearchStateCounts(db: SyncDatabase): SessionSearchStateCounts {
  const rows = db.prepare('SELECT state, count(*) AS n FROM files GROUP BY state').all()
  const counts: SessionSearchStateCounts = {
    current: 0,
    due: 0,
    failed: 0,
    sessionsByAgent: sessionSearchSessionsByAgent(db),
    messages: 0
  }
  for (const row of rows) {
    if (row.state === 'current' || row.state === 'due' || row.state === 'failed') {
      counts[row.state] = Number(row.n)
    }
  }
  counts.messages = Number(asRecord(db.prepare('SELECT count(*) AS n FROM messages').get())?.n ?? 0)
  return counts
}
