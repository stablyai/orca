// Postgres introspection SQL + row mappers. Kept pure and separate so the SQL is
// unit-testable and the driver just supplies params (schema name, cap+1) and maps
// rows. Aliases are snake_case because Postgres folds unquoted identifiers to
// lowercase — the mappers translate to the camelCase shared types.

import type { DbColumn, DbTable } from '../../shared/database-types'

// User schemas in the connected database, excluding system namespaces. $1 = cap.
export const PG_SCHEMAS_SQL = `SELECT schema_name AS name
FROM information_schema.schemata
WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
  AND schema_name NOT LIKE 'pg_%'
ORDER BY schema_name
LIMIT $1`

// Tables + views in one schema. $1 = schema, $2 = cap.
export const PG_TABLES_SQL = `SELECT table_name AS name, table_type AS type
FROM information_schema.tables
WHERE table_schema = $1
ORDER BY table_name
LIMIT $2`

// Columns of one table with primary-key membership. $1 = schema, $2 = table.
export const PG_COLUMNS_SQL = `SELECT c.column_name AS name,
  c.data_type AS data_type,
  c.is_nullable AS is_nullable,
  (pk.column_name IS NOT NULL) AS is_primary_key
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
   AND tc.table_name = kcu.table_name
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1
    AND tc.table_name = $2
) pk ON pk.column_name = c.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position`

export function mapSchemaRows(rows: { name: string }[]): string[] {
  return rows.map((row) => row.name)
}

export function mapTableRows(rows: { name: string; type: string }[]): DbTable[] {
  return rows.map((row) => ({
    name: row.name,
    kind: row.type === 'VIEW' ? 'view' : 'table'
  }))
}

export function mapColumnRows(
  rows: {
    name: string
    data_type: string
    is_nullable: string
    is_primary_key: boolean
  }[]
): DbColumn[] {
  return rows.map((row) => ({
    name: row.name,
    dataType: row.data_type,
    nullable: row.is_nullable === 'YES',
    isPrimaryKey: row.is_primary_key === true
  }))
}
