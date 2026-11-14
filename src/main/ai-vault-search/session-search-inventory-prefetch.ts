import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchPhysicalTable } from './session-search-inventory-page'

function* requestedPages(paths: Iterable<string>, known: (path: string) => boolean) {
  let page = new Set<string>(),
    bytes = 1024
  for (const path of paths) {
    if (known(path) || page.has(path)) {
      continue
    }
    const size = JSON.stringify(path).length * 2 + 64
    if (page.size && (page.size === 16 || bytes + size > 256 * 1024)) {
      yield [...page]
      page = new Set()
      bytes = 1024
    }
    page.add(path)
    bytes += size
  }
  if (page.size) {
    yield [...page]
  }
}

/** Requested keys also return absent facts; unrequested keys remain unknown. */
export function* projectSessionSearchPhysical(
  db: SyncDatabase,
  table: SessionSearchPhysicalTable,
  columns: string,
  source: number,
  paths: Iterable<string>,
  known: (path: string) => boolean,
  reserve: (payload: string, rows: number) => void
): Generator<{ path: string; row: Record<string, unknown> }> {
  for (const page of requestedPages(paths, known)) {
    const requested = page.filter((path) => !known(path))
    if (!requested.length) {
      continue
    }
    const payload = JSON.stringify(requested)
    reserve(payload, requested.length)
    const rows = db
      .prepare(`SELECT requested.value AS requested_path,${columns
        .split(',')
        .map((column) => `facts.${column}`)
        .join(',')}
        FROM json_each(?) requested LEFT JOIN temp.${table} facts
        ON facts.source=? AND facts.path=requested.value`)
      .iterate(payload, source)
    for (const row of rows) {
      const { requested_path, ...facts } = row
      yield { path: String(requested_path), row: facts }
    }
  }
}

export function* projectSessionSearchFallback(
  db: SyncDatabase,
  scope: string,
  paths: Iterable<string>,
  known: (path: string) => boolean,
  reserve: (payload: string, rows: number) => void
) {
  for (const page of requestedPages(paths, known)) {
    const requested = page.filter((path) => !known(path))
    if (!requested.length) {
      continue
    }
    const payload = JSON.stringify(requested)
    reserve(payload, requested.length)
    const rows = db
      .prepare(`SELECT requested.value AS requested_path,facts.key,facts.value,
        facts.parent,facts.group_key,facts.rank,facts.ready,facts.tie
        FROM json_each(?) requested LEFT JOIN temp.search_catalog facts
        ON facts.scope=? AND facts.key=requested.value`)
      .iterate(payload, scope)
    for (const row of rows) {
      yield {
        path: String(row.requested_path),
        value:
          row.key == null
            ? undefined
            : {
                key: String(row.key),
                data: JSON.parse(String(row.value)),
                parent: String(row.parent),
                group: String(row.group_key),
                rank: Number(row.rank),
                ready: Number(row.ready),
                tie: Number(row.tie)
              }
      }
    }
  }
}
