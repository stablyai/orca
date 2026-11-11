import type { SessionSearchStateCounts } from './storage/session-search-store-types'
import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchSnapshotRow } from './worker/session-search-worker-protocol'
import { boundedSessionSearchPage } from './session-search-catalog-pages'

export function readSessionSearchSnapshotRows(
  store: SessionSearchStore | null,
  path?: string,
  after?: string
): SessionSearchSnapshotRow[] {
  if (!store) {
    return []
  }
  return boundedSessionSearchPage(
    store.connection
      .prepare(`SELECT f.path, CAST(f.dev AS REAL) AS dev, CAST(f.ino AS REAL) AS ino,
    f.mtime_ms, f.size_bytes, f.state, f.fail_count, f.failed_mtime_ms, f.byte_offset, f.prefix_hash,
    s.agent, s.content_hash, s.content_hash_count FROM files f LEFT JOIN sessions s ON s.id=f.session_row_id
    ${path === undefined ? 'WHERE f.path > ? ORDER BY f.path LIMIT 256' : 'WHERE f.path = ?'}`)
      .iterate(path ?? after ?? ''),
    (row) => ({
      path: String(row.path),
      identity:
        typeof row.dev === 'number' && typeof row.ino === 'number'
          ? { dev: row.dev, ino: row.ino }
          : null,
      mtimeMs: Number(row.mtime_ms),
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      state: row.state === 'due' ? 'due' : row.state === 'failed' ? 'failed' : 'current',
      failCount: Number(row.fail_count),
      failedMtimeMs: row.failed_mtime_ms === null ? null : Number(row.failed_mtime_ms),
      byteOffset: row.byte_offset === -1 ? null : Number(row.byte_offset),
      prefixHash: typeof row.prefix_hash === 'string' ? row.prefix_hash : null,
      agent: typeof row.agent === 'string' ? row.agent : null,
      contentHash: {
        hash: typeof row.content_hash === 'string' ? row.content_hash : null,
        count: Number(row.content_hash_count ?? 0)
      }
    })
  )
}

export function applySessionSearchFileCountDelta(
  counts: SessionSearchStateCounts,
  row: Pick<SessionSearchSnapshotRow, 'state' | 'agent'> | null,
  previous: Pick<SessionSearchSnapshotRow, 'state' | 'agent'> | undefined
): void {
  if (previous) {
    counts[previous.state]--
    if (previous.agent) {
      counts.sessionsByAgent[previous.agent]--
    }
  }
  if (row) {
    counts[row.state]++
    if (row.agent) {
      counts.sessionsByAgent[row.agent] = (counts.sessionsByAgent[row.agent] ?? 0) + 1
    }
  }
  for (const agent of Object.keys(counts.sessionsByAgent)) {
    if (!counts.sessionsByAgent[agent]) {
      delete counts.sessionsByAgent[agent]
    }
  }
}

export function sessionSearchWorkerDelta(
  store: SessionSearchStore,
  counts: SessionSearchStateCounts,
  path: string,
  previous: SessionSearchSnapshotRow | undefined,
  final?: { row: SessionSearchSnapshotRow | undefined }
) {
  const row = (final ? final.row : readSessionSearchSnapshotRows(store, path)[0]) ?? null
  applySessionSearchFileCountDelta(counts, row, previous)
  if (!final) {
    store.catalogCandidates.rowChanged(path)
  }
  return { path, row }
}
