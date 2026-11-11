import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchCandidateRow } from './session-search-catalog-candidate-types'
import { boundedSessionSearchPage } from './session-search-catalog-pages'

export function readSessionSearchCandidateRows(
  db: SyncDatabase,
  where: string,
  values: (string | number)[]
): SessionSearchCandidateRow[] {
  return boundedSessionSearchPage(
    db.prepare(`SELECT * FROM temp.search_candidates ${where}`).iterate(...values),
    (row) => ({
      key: String(row.key),
      root: String(row.root),
      group: String(row.group_key),
      alias: String(row.alias_key),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this private table only accepts typed candidate commands.
      candidate: JSON.parse(String(row.candidate)) as SessionFileCandidate,
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
    })
  )
}
