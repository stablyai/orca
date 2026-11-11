import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalog } from './session-search-catalog'
import type { SessionSearchFileState } from './storage/session-search-store-types'
import { recordSessionSearchPrimaryFailure } from './session-search-primary-retries'

export function applySessionSearchFileState(
  db: SyncDatabase,
  path: string,
  state: SessionSearchFileState,
  atMtimeMs: number | undefined,
  catalog: SessionSearchCatalog | undefined
): void {
  if (state === 'failed') {
    // Persist initial failures too, or unreadable new files retry forever.
    db.prepare(`INSERT INTO files(path, byte_offset, mtime_ms, state, fail_count, failed_mtime_ms)
      VALUES (?, 0, ?, 'failed', 1, ?)
      ON CONFLICT(path) DO UPDATE SET state='failed',fail_count=files.fail_count+1,failed_mtime_ms=excluded.failed_mtime_ms`).run(
      path,
      atMtimeMs ?? 0,
      atMtimeMs ?? null
    )
    recordSessionSearchPrimaryFailure(catalog!, path, true)
    return
  }
  db.prepare(
    'UPDATE files SET state = ?, fail_count = 0, failed_mtime_ms = NULL WHERE path = ?'
  ).run(state, path)
  if (catalog) {
    recordSessionSearchPrimaryFailure(catalog, path, false)
  }
}
