import { sessionSearchRecordPages } from './session-search-catalog-pages'
import type { SessionSearchCatalogPublications } from './session-search-catalog-publications'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogCandidate } from './session-search-catalog-candidate-types'
import { sessionSearchCandidateFacts } from './session-search-candidate-facts'

export function independentSessionSearchCandidates(
  db: SyncDatabase,
  rows: SessionSearchCatalogCandidate[]
) {
  const groups = new Set<string>(),
    paths = new Set<string>(),
    repeatedGroups = new Set<string>(),
    repeatedPaths = new Set<string>()
  for (const row of rows) {
    if (groups.has(row.group)) {
      repeatedGroups.add(row.group)
    }
    if (paths.has(row.candidate.file.path)) {
      repeatedPaths.add(row.candidate.file.path)
    }
    groups.add(row.group)
    paths.add(row.candidate.file.path)
  }
  const requested = rows.map((row) => [row.group, row.candidate.file.path])
  const present = db
    .prepare(`SELECT json_extract(value,'$[0]') AS group_key,json_extract(value,'$[1]') AS path
    FROM json_each(?) WHERE
    EXISTS(SELECT 1 FROM temp.search_candidates WHERE group_key=json_extract(value,'$[0]')) OR
    EXISTS(SELECT 1 FROM temp.search_candidates WHERE path=json_extract(value,'$[1]')) OR
    EXISTS(SELECT 1 FROM temp.search_read_work WHERE path=json_extract(value,'$[1]'))`)
    .all(JSON.stringify(requested))
  for (const row of present) {
    repeatedGroups.add(String(row.group_key))
    repeatedPaths.add(String(row.path))
  }
  return new Set(
    rows.filter(
      (row) =>
        !row.sqlite &&
        !row.group.startsWith('antigravity:') &&
        !repeatedGroups.has(row.group) &&
        !repeatedPaths.has(row.candidate.file.path)
    )
  )
}

export function insertIndependentSessionSearchCandidates(
  db: SyncDatabase,
  rows: SessionSearchCatalogCandidate[],
  revision: () => number
): void {
  const facts = sessionSearchCandidateFacts(db).insertPage(rows.map((row) => row.candidate))
  const values = rows.map((row, index) => {
    let current = revision()
    if (row.force) {
      current = revision()
    }
    if (row.metadata) {
      current = revision()
    }
    return [
      `${row.group}\0${row.candidate.agent}:${row.candidate.file.path}`,
      row.candidate.file.path,
      row.candidate.agent,
      row.root,
      row.group,
      row.alias,
      facts[index].id,
      facts[index].revision,
      row.preference,
      row.sourceOrder,
      row.candidate.file.mtimeMs,
      row.sourcePath ?? '',
      Number(!!row.force || !!row.metadata),
      Number(!!row.force),
      Number(!!row.metadata),
      current
    ]
  })
  db.prepare(`INSERT INTO temp.search_candidates
    (key,path,agent,root,group_key,alias_key,fact_id,fact_revision,preference,source_order,mtime,source_path,required,force_read,metadata,revision,sqlite_source,selected,changed)
    SELECT ${values[0].map((_, index) => `json_extract(value,'$[${index}]')`).join(',')},0,1,1 FROM json_each(?)`).run(
    JSON.stringify(values)
  )
}

export function putSessionSearchCandidateBatch(
  db: SyncDatabase,
  rows: SessionSearchCatalogCandidate[],
  publications: SessionSearchCatalogPublications,
  revision: () => number,
  inserted: (count: number) => void,
  put: (row: SessionSearchCatalogCandidate) => void
): void {
  if (!rows.length) {
    return
  }
  const independent = independentSessionSearchCandidates(db, rows)
  let run: SessionSearchCatalogCandidate[] = []
  const flush = () => {
    for (const page of sessionSearchRecordPages(run)) {
      insertIndependentSessionSearchCandidates(db, page, revision)
      publications.selectedSingles(page.map((row) => row.group))
      inserted(page.length)
    }
    run = []
  }
  for (const row of rows) {
    if (independent.has(row)) {
      run.push(row)
    } else {
      flush()
      put(row)
    }
  }
  flush()
}
