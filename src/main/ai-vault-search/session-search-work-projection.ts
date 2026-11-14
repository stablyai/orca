import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchWork } from './session-search-work-catalog'
import { SESSION_SEARCH_CATALOG_PAGE_BYTES } from './session-search-catalog'
import { sessionSearchStoredCandidate } from './session-search-candidate-facts'

const currentWork = `SELECT w.path,w.fact_id,w.fact_revision,w.version,w.force_read,w.metadata,w.ordering,w.deferred,
  f.id AS snapshot_id,f.path AS fact_path,f.agent,f.mtime,f.size,f.dev,f.ino,f.nlink,f.alias_mtime,f.sidecar,f.codex_home,f.history_path,
  (SELECT root FROM temp.search_candidates WHERE path=f.path AND agent=f.agent AND selected=1 ORDER BY key LIMIT 1) AS root
  FROM temp.search_read_work w LEFT JOIN temp.search_candidate_facts f ON f.id=w.fact_id AND f.snapshot_revision=w.fact_revision`

export function readSessionSearchCurrentWork(db: SyncDatabase, path: string) {
  return db.prepare(`${currentWork} WHERE w.path=?`).get(path)
}

export function decodeSessionSearchCurrentWork(row: Record<string, unknown>): SessionSearchWork {
  if (row.snapshot_id == null) {
    throw new Error('Session work candidate snapshot is unavailable')
  }
  return projectSessionSearchWork(
    row,
    sessionSearchStoredCandidate({ ...row, path: row.fact_path }),
    row.root ?? undefined
  )
}

export function projectSessionSearchWork(
  row: Record<string, unknown>,
  candidate: SessionFileCandidate,
  root: unknown
): SessionSearchWork {
  return {
    candidate,
    version: Number(row.version),
    force: row.force_read === 1,
    metadata: row.metadata === 1,
    root: root === undefined ? undefined : String(root),
    receipt: {
      path: String(row.path),
      version: Number(row.version),
      fact: Number(row.fact_id),
      factRevision: Number(row.fact_revision),
      ordering: Number(row.ordering),
      deferred: row.deferred === 1,
      force: row.force_read === 1,
      metadata: row.metadata === 1
    }
  }
}

export function readSessionSearchWorkPage(
  db: SyncDatabase,
  eligibleThrough: number,
  chooseChanged: boolean
): SessionSearchWork[] {
  const lanes = (['changed', 'backlog'] as const).map((lane) =>
    db
      .prepare(`${currentWork}
          WHERE w.lane='${lane}' AND (w.deferred=0 OR w.ordering<=?) ORDER BY w.rank,w.ordering,w.path LIMIT 256`)
      .iterate(eligibleThrough)
  )
  const works: SessionSearchWork[] = []
  let bytes = 1024,
    selected = chooseChanged ? 0 : 1
  const exhausted = [false, false]
  try {
    while (works.length < 256) {
      if (exhausted[selected]) {
        selected = 1 - selected
        if (exhausted[selected]) {
          break
        }
      }
      const row = lanes[selected].next()
      if (row.done) {
        exhausted[selected] = true
        continue
      }
      const work = decodeSessionSearchCurrentWork(row.value)
      const size = JSON.stringify(work).length * 2 + 64
      if (works.length && bytes + size > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
        break
      }
      works.push(work)
      bytes += size
      if (bytes >= SESSION_SEARCH_CATALOG_PAGE_BYTES) {
        break
      }
      selected = 1 - selected
    }
  } finally {
    for (const lane of lanes) {
      lane.return?.()
    }
  }
  return works
}
