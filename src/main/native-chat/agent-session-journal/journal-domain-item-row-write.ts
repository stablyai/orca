import type { SQLInputValue } from 'node:sqlite'
import type Database from '../../sqlite/sync-database'

type Prefix = readonly [sessionId: string, epoch: string]
export type JournalItemRowColumn = readonly [column: string, value: SQLInputValue]

const KEY_COLUMNS = new Set(['session_id', 'epoch', 'item_id'])
const indexedColumnsByDb = new WeakMap<Database.Database, ReadonlySet<string>>()
// Each changed-column set is its own statement; past this many, saves name every column again so
// they can't crowd other statements out of the connection's statement cache.
const UPDATE_SHAPES_LIMIT = 32
const updateShapesByDb = new WeakMap<Database.Database, Set<string>>()

/** Every journal_items column an index names in its key, an expression or its WHERE clause. */
export function journalItemIndexedColumns(db: Database.Database): ReadonlySet<string> {
  const known = indexedColumnsByDb.get(db)
  if (known) {
    return known
  }
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('journal_items')`)
    .all()
    .map((row) => String(row.name))
  const indexes = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='journal_items'`)
    .all()
  const named = new Set<string>()
  for (const { sql } of indexes) {
    // An automatic index has no SQL; it covers the primary key, which is never SET.
    if (typeof sql !== 'string') {
      continue
    }
    const body = sql.slice(sql.search(/\bON\s+journal_items\b/i))
    for (const column of columns) {
      if (new RegExp(`\\b${column}\\b`).test(body)) {
        named.add(column)
      }
    }
  }
  indexedColumnsByDb.set(db, named)
  return named
}

function sameValue(a: unknown, b: SQLInputValue): boolean {
  if (a instanceof Uint8Array && ArrayBuffer.isView(b)) {
    return Buffer.compare(a, new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) === 0
  }
  return a === b
}

/**
 * Inserts or updates one item row. SQLite rewrites an index whenever an UPDATE names any column
 * it covers, even with an unchanged value, so an indexed column is SET only when it changed.
 * `payload_json` is always SET so `journal_text_tail_rewritten` fires as before.
 */
export function writeJournalDomainItemRow(
  db: Database.Database,
  prefix: Prefix,
  itemId: string,
  columns: readonly JournalItemRowColumn[]
): void {
  const indexed = journalItemIndexedColumns(db)
  const compared = columns.filter(
    ([column]) => indexed.has(column) && column !== 'payload_json' && !KEY_COLUMNS.has(column)
  )
  const previous = db
    .prepare(
      `SELECT 1 AS present${compared.map(([column]) => `,${column}`).join('')} FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=?`
    )
    .get(...prefix, itemId)
  if (!previous) {
    db.prepare(
      `INSERT INTO journal_items(session_id,epoch,item_id,${columns.map(([column]) => column).join(',')})
        VALUES(?,?,?${',?'.repeat(columns.length)})`
    ).run(...prefix, itemId, ...columns.map(([, value]) => value))
    return
  }
  const changed = columns.filter(
    ([column, value]) =>
      !indexed.has(column) || column === 'payload_json' || !sameValue(previous[column], value)
  )
  const shapes = updateShapesByDb.get(db) ?? new Set<string>()
  updateShapesByDb.set(db, shapes)
  const changedShape = changed.map(([column]) => column).join(',')
  const capped = !shapes.has(changedShape) && shapes.size >= UPDATE_SHAPES_LIMIT
  if (!capped) {
    shapes.add(changedShape)
  }
  const named = capped ? columns : changed
  db.prepare(
    `UPDATE journal_items SET ${named.map(([column]) => `${column}=?`).join(',')}
      WHERE session_id=? AND epoch=? AND item_id=?`
  ).run(...named.map(([, value]) => value), ...prefix, itemId)
}
