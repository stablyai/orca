import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCandidateRow } from './session-search-catalog-candidate-types'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import { sessionSearchStoredCandidate } from './session-search-candidate-facts'

export function readSessionSearchCandidateRows(
  db: SyncDatabase,
  where: string,
  values: (string | number)[]
): SessionSearchCandidateRow[] {
  return boundedSessionSearchPage(
    db
      .prepare(`SELECT * FROM (SELECT c.*,f.snapshot_revision AS stored_fact_revision,f.size,f.dev,f.ino,f.nlink,f.alias_mtime,f.sidecar,f.codex_home,f.history_path
      FROM temp.search_candidates c LEFT JOIN temp.search_candidate_facts f ON f.id=c.fact_id AND f.snapshot_revision=c.fact_revision) ${where}`)
      .iterate(...values),
    (row) => {
      if (row.stored_fact_revision == null) {
        throw new Error('Session selection candidate snapshot is unavailable')
      }
      return {
        key: String(row.key),
        root: String(row.root),
        group: String(row.group_key),
        alias: String(row.alias_key),
        candidate: sessionSearchStoredCandidate(row),
        sqlite: row.sqlite_source === 1,
        preference: Number(row.preference),
        sourceOrder: Number(row.source_order),
        sourcePath: String(row.source_path),
        selected: row.selected === 1,
        protectedPath: !!db
          .prepare('SELECT 1 FROM temp.search_candidates WHERE path=? AND selected=1 LIMIT 1')
          .get(String(row.path)),
        required: row.required === 1,
        forced: row.force_read === 1,
        metadata: row.metadata === 1,
        revision: Number(row.revision)
      }
    }
  )
}
