import { inventoryValueBytes } from './session-search-inventory-footprint'
export const inventoryProjectionKeys = 16
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
    if (page.size && (page.size === inventoryProjectionKeys || bytes + size > 256 * 1024)) {
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
  reserve: (payload: string, rows: number) => boolean,
  reserveRow: (row?: Record<string, unknown>) => boolean
): Generator<{ path: string; row: Record<string, unknown> }> {
  for (const page of requestedPages(paths, known)) {
    const requested = page.filter((path) => !known(path))
    if (!requested.length) {
      continue
    }
    const payload = JSON.stringify(requested)
    if (!reserve(payload, requested.length)) {
      return
    }
    const rows = db
      .prepare(`SELECT requested.value AS requested_path,${columns
        .split(',')
        .map((column) => `facts.${column}`)
        .join(',')}
        FROM json_each(?) requested LEFT JOIN temp.${table} facts
        ON facts.source=? AND facts.path=requested.value`)
      .iterate(payload, source)
    for (const row of rows) {
      if (!reserveRow(row)) {
        return
      }
      try {
        const { requested_path, ...facts } = row
        yield { path: String(requested_path), row: facts }
      } finally {
        reserveRow()
      }
    }
  }
}

export function* projectSessionSearchFallback(
  db: SyncDatabase,
  scope: string,
  paths: Iterable<string>,
  known: (path: string) => boolean,
  reserve: (payload: string, rows: number) => boolean,
  reserveRow: (row?: Record<string, unknown>) => boolean
) {
  for (const page of requestedPages(paths, known)) {
    const requested = page.filter((path) => !known(path))
    if (!requested.length) {
      continue
    }
    const payload = JSON.stringify(requested)
    if (!reserve(payload, requested.length)) {
      return
    }
    const rows = db
      .prepare(`SELECT requested.value AS requested_path,facts.key,facts.value,
        facts.parent,facts.group_key,facts.rank,facts.ready,facts.tie
        FROM json_each(?) requested LEFT JOIN temp.search_catalog facts
        ON facts.scope=? AND facts.key=requested.value`)
      .iterate(payload, scope)
    for (const row of rows) {
      if (!reserveRow(row)) {
        return
      }
      try {
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
      } finally {
        reserveRow()
      }
    }
  }
}

export class SessionSearchInventoryProjection {
  constructor(
    private readonly ledger: {
      delete(key: string): void
      set(key: string, bytes: number, rows: number): void
      fits(changes: [string, number, number][]): boolean
    }
  ) {}
  projectionComplete = true
  private queryPayloadBytes = 0
  private queryRows = 0
  refusedProjection(value: unknown): void {
    this.ledger.set('projection-refused', inventoryValueBytes('projection', value), 1)
  }
  releaseQuery(): void {
    this.ledger.delete('projection-refused')
    this.ledger.delete('query')
    this.queryPayloadBytes = this.queryRows = 0
  }
  reserveQuery(payload: string, rows: number): boolean {
    this.releaseQuery()
    this.projectionComplete = true
    this.queryPayloadBytes = payload.length * 4
    this.queryRows = rows + 1
    if (!this.ledger.fits([['query', this.queryPayloadBytes, this.queryRows]])) {
      this.projectionComplete = false
      return false
    }
    this.ledger.set('query', this.queryPayloadBytes, this.queryRows)
    return true
  }
  reserveQueryRow(row?: Record<string, unknown>): boolean {
    const bytes = this.queryPayloadBytes + (row ? inventoryValueBytes('query-row', row) : 0)
    if (!this.ledger.fits([['query', bytes, this.queryRows]])) {
      this.projectionComplete = false
      this.ledger.set('query', bytes, this.queryRows)
      return false
    }
    this.ledger.set('query', bytes, this.queryRows)
    return true
  }
  borrow<T>(row: Record<string, unknown>, decode: (row: Record<string, unknown>) => T): T {
    this.ledger.set('borrowed-row', inventoryValueBytes('scalar', row), 1)
    try {
      const value = decode(row)
      this.ledger.set('borrowed-value', inventoryValueBytes('decoded', value), 1)
      return value
    } finally {
      this.ledger.delete('borrowed-row')
      this.ledger.delete('borrowed-value')
    }
  }
}
