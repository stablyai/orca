import type { SchemaLockTarget } from './schema-lock-target.js'

export type SchemaCatalogRow = Record<string, unknown>

// Runs with `$n` placeholders bound to the lock target, on the same connection the DDL would use.
export type SchemaCatalogQuery = (
  sql: string,
  params: unknown[]
) => Promise<SchemaCatalogRow[]>

// Resolve index in table’s schema and bind indrelid or a sibling’s same-named index permanently suppresses creation.
// to_regclass returns NULL for absent cold-start tables.
const INDEX_PRESENT = `SELECT i.indisvalid FROM pg_catalog.pg_class t
JOIN pg_catalog.pg_class c ON c.relnamespace = t.relnamespace AND c.relname = $2
JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid AND i.indrelid = t.oid
WHERE t.oid = to_regclass($1)`

const COLUMN_PRESENT = `SELECT 1 FROM pg_catalog.pg_attribute
WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped`

// Compare constraint name only; region-derived CHECK changes must not trigger table scans on every region update.
const CONSTRAINT_PRESENT = `SELECT 1 FROM pg_catalog.pg_constraint
WHERE conrelid = to_regclass($1) AND conname = $2`

// DROP INDEX resolves through search_path without a table; match relkind i to exclude tables/views and unsupported partitioned indexes (I).
const INDEX_BY_NAME_PRESENT = `SELECT 1 FROM pg_catalog.pg_class c
WHERE c.relname = $1 AND c.relkind = 'i' AND pg_catalog.pg_table_is_visible(c.oid)`

// Compare complete reloption name=value pair so changed values reapply; defaults have no reloptions entry.
const RELOPTION_PRESENT = `SELECT 1 FROM pg_catalog.pg_class
WHERE oid = to_regclass($1) AND reloptions @> ARRAY[$2]`

const PRESENCE_SQL = {
  index: INDEX_PRESENT,
  column: COLUMN_PRESENT,
  constraint: CONSTRAINT_PRESENT,
  reloption: RELOPTION_PRESENT,
  'index-by-name': INDEX_BY_NAME_PRESENT
} as const

export type SchemaCatalogPresence = { present: boolean; indisvalid: unknown }

// Existence alone matches IF NOT EXISTS, even for invalid cancelled builds; checking validity would take new locks.
export async function catalogObjectPresence(
  query: SchemaCatalogQuery,
  target: SchemaLockTarget
): Promise<SchemaCatalogPresence> {
  const sql = PRESENCE_SQL[target.kind]
  // Bind only referenced parameters; the table-less lookup has one, and unused extras cause bind errors.
  const params = target.kind === 'index-by-name' ? [target.name] : [target.table, target.name]
  const rows = await query(sql, params)
  const row = rows[0]
  return row ? { present: true, indisvalid: row.indisvalid } : { present: false, indisvalid: undefined }
}
