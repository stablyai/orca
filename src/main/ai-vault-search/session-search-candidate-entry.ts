import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogCandidate } from './session-search-catalog-candidate-types'
import { readSessionSearchCandidateRows } from './session-search-candidate-rows'
import { sessionSearchFileValues } from './session-search-file-facts'
import {
  sessionSearchCandidateFacts,
  type SessionSearchFactReference
} from './session-search-candidate-facts'

export function putSessionSearchCandidate(
  db: SyncDatabase,
  row: SessionSearchCatalogCandidate,
  select: (group: string, alias: string, sqlite: boolean) => void
): void {
  const key = `${row.group}\0${row.candidate.agent}:${row.candidate.file.path}`
  let previousFact: SessionSearchFactReference | undefined
  const previous = readSessionSearchCandidateRows(db, 'WHERE key = ?', [key], (reference) => {
    previousFact = reference
  })[0]
  if (
    previous &&
    previous.candidate.agent === row.candidate.agent &&
    previous.candidate.codexHome === row.candidate.codexHome &&
    previous.candidate.antigravityHistoryPath === row.candidate.antigravityHistoryPath &&
    JSON.stringify(sessionSearchFileValues(previous.candidate.file)) ===
      JSON.stringify(sessionSearchFileValues(row.candidate.file)) &&
    previous.root === row.root &&
    previous.alias === row.alias &&
    previous.sqlite === row.sqlite &&
    previous.preference === row.preference &&
    previous.sourceOrder === row.sourceOrder &&
    previous.sourcePath === (row.sourcePath ?? '')
  ) {
    return
  }
  const facts = sessionSearchCandidateFacts(db)
  const workFact = facts.work(row.candidate.file.path)
  const reference = facts.acquire(
    row.candidate,
    [previousFact, workFact].filter((fact) => fact !== undefined),
    previous && previousFact
      ? { reference: previousFact, candidate: previous.candidate }
      : undefined
  )
  db.prepare(`INSERT INTO temp.search_candidates
      (key,path,agent,root,group_key,alias_key,fact_id,fact_revision,sqlite_source,preference,source_order,mtime,required,source_path)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      root=excluded.root,group_key=excluded.group_key,alias_key=excluded.alias_key,
      mtime=excluded.mtime,fact_id=excluded.fact_id,fact_revision=excluded.fact_revision,
      sqlite_source=excluded.sqlite_source,preference=excluded.preference,source_order=excluded.source_order,source_path=excluded.source_path`).run(
    key,
    row.candidate.file.path,
    row.candidate.agent,
    row.root,
    row.group,
    row.alias,
    reference.id,
    reference.revision,
    Number(row.sqlite),
    row.preference,
    row.sourceOrder,
    row.candidate.file.mtimeMs,
    Number(previous?.required ?? false),
    row.sourcePath ?? ''
  )
  facts.reclaim(previousFact)
  select(row.group, row.alias, row.sqlite)
  if (previous && (previous.group !== row.group || previous.alias !== row.alias)) {
    select(previous.group, previous.alias, previous.sqlite)
  }
}
