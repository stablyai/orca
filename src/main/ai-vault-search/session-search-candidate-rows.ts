import type { SessionSearchFactReference } from './session-search-candidate-facts'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCandidateRow } from './session-search-catalog-candidate-types'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import { sessionSearchStoredCandidate } from './session-search-candidate-facts'

export function readSessionSearchCandidateRows(
  db: SyncDatabase,
  where: string,
  values: (string | number)[],
  snapshot?: (reference: SessionSearchFactReference) => void
): SessionSearchCandidateRow[] {
  return boundedSessionSearchPage(
    db
      .prepare(`SELECT protected_path,key,path,agent,root,group_key,alias_key,fact_id,fact_revision,sqlite_source,preference,source_order,mtime,source_path,selected,required,force_read,metadata,revision,changed,stored_fact_revision,size,dev,ino,nlink,alias_mtime,sidecar,codex_home,history_path FROM (SELECT EXISTS(SELECT 1 FROM temp.search_candidates selected_path WHERE selected_path.path=c.path AND selected_path.selected=1) AS protected_path,c.key,c.path,c.agent,c.root,c.group_key,c.alias_key,c.fact_id,c.fact_revision,c.sqlite_source,c.preference,c.source_order,c.mtime,c.source_path,c.selected,c.required,c.force_read,c.metadata,c.revision,c.changed,f.snapshot_revision AS stored_fact_revision,f.size,f.dev,f.ino,f.nlink,f.alias_mtime,f.sidecar,f.codex_home,f.history_path
      FROM temp.search_candidates c LEFT JOIN temp.search_candidate_facts f ON f.id=c.fact_id AND f.snapshot_revision=c.fact_revision) ${where}`)
      .iterate(...values),
    (row) => {
      if (row.stored_fact_revision == null) {
        throw new Error('Session selection candidate snapshot is unavailable')
      }
      snapshot?.({ id: Number(row.fact_id), revision: Number(row.fact_revision) })
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
        protectedPath: row.protected_path === 1,
        required: row.required === 1,
        forced: row.force_read === 1,
        metadata: row.metadata === 1,
        revision: Number(row.revision)
      }
    }
  )
}
