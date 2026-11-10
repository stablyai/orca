import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogPublications } from './session-search-catalog-publications'

export function selectSessionSearchCandidates(
  db: SyncDatabase,
  group: string,
  alias: string,
  sqlite: boolean,
  revision: number,
  publications: SessionSearchCatalogPublications
): number {
  if (group.startsWith('antigravity:')) {
    db.prepare(`UPDATE temp.search_candidates SET candidate = json_set(candidate,'$.file.aliasMtimeMs',
        (SELECT max(mtime) FROM temp.search_candidates WHERE group_key = ?)) WHERE group_key = ?`).run(
      group,
      group
    )
  }
  const hasSqlite =
    db
      .prepare(
        'SELECT 1 FROM temp.search_candidates WHERE group_key = ? AND sqlite_source = 1 LIMIT 1'
      )
      .get(group) !== undefined
  const scope = hasSqlite || sqlite ? 'group_key = ?' : 'group_key = ? AND alias_key = ?'
  const values = hasSqlite || sqlite ? [group] : [group, alias]
  const winner = hasSqlite
    ? db
        .prepare(`SELECT key FROM temp.search_candidates WHERE group_key = ? AND sqlite_source = 1
          ORDER BY mtime DESC,source_order,key LIMIT 1`)
        .get(group)?.key
    : db
        .prepare(`SELECT key FROM temp.search_candidates WHERE group_key = ? AND alias_key = ?
          ORDER BY preference,key LIMIT 1`)
        .get(group, alias)?.key
  const members = Number(
    db.prepare('SELECT count(*) AS n FROM temp.search_candidates WHERE group_key = ?').get(group)
      ?.n ?? 0
  )
  publications.selected(group, revision, members > 1)
  const changed = Number(
    db
      .prepare(`SELECT count(*) AS n FROM temp.search_candidates
      WHERE ${scope} AND changed = 0`)
      .get(...values)?.n ?? 0
  )
  db.prepare(`UPDATE temp.search_candidates SET selected = ${sqlite && !hasSqlite ? '1' : '(key = ?)'},
      revision = ?,changed = 1 WHERE ${scope}`).run(
    ...(sqlite && !hasSqlite ? [revision, ...values] : [winner ?? '', revision, ...values])
  )
  return changed
}
