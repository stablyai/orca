import type { SchemaLockTarget } from './schema-lock-target.js'

export type SchemaCatalogRow = Record<string, unknown>

// Runs with `$n` placeholders bound to the lock target, on the same connection the DDL would use.
export type SchemaCatalogQuery = (
  sql: string,
  params: unknown[]
) => Promise<SchemaCatalogRow[]>

// The index name is resolved inside the table's own namespace, and `i.indrelid = t.oid` ties it to
// this table: index names are unique per schema, not per table, so without that condition a
// same-named index on a sibling table answers yes and the real index is skipped forever.
// `to_regclass` returns NULL rather than erroring when the table does not exist yet, which is the
// whole of a cold start.
const INDEX_PRESENT = `SELECT i.indisvalid FROM pg_catalog.pg_class t
JOIN pg_catalog.pg_class c ON c.relnamespace = t.relnamespace AND c.relname = $2
JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid AND i.indrelid = t.oid
WHERE t.oid = to_regclass($1)`

const COLUMN_PRESENT = `SELECT 1 FROM pg_catalog.pg_attribute
WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped`

// Name only. The CHECK body is generated from RELAY_REGIONS, so comparing it would re-run the swap
// on every region change, and an ADD CONSTRAINT is the one statement here that scans the table.
const CONSTRAINT_PRESENT = `SELECT 1 FROM pg_catalog.pg_constraint
WHERE conrelid = to_regclass($1) AND conname = $2`

const PRESENCE_SQL = {
  index: INDEX_PRESENT,
  column: COLUMN_PRESENT,
  constraint: CONSTRAINT_PRESENT
} as const

export type SchemaCatalogPresence = { present: boolean; indisvalid: unknown }

// Row presence is the answer, whatever the row says. An index left invalid by a cancelled
// concurrent build is skipped by `IF NOT EXISTS` today as well, so reading `indisvalid` as a
// condition would newly take the lock for exactly the indexes a failed build left behind.
export async function catalogObjectPresence(
  query: SchemaCatalogQuery,
  target: SchemaLockTarget
): Promise<SchemaCatalogPresence> {
  const sql = PRESENCE_SQL[target.kind]
  const rows = await query(sql, [target.table, target.name])
  const row = rows[0]
  return row ? { present: true, indisvalid: row.indisvalid } : { present: false, indisvalid: undefined }
}
