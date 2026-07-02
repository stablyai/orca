// MySQL introspection SQL + row mappers. Named/aliased columns keep the result
// keys stable (mysql2 returns keys as written in the SELECT) so the mappers read
// deterministic snake_case fields. Uses `?` placeholders and a plain LIMIT so it
// works on MySQL 5.7+ (no window functions).

import type { DbColumn, DbTable } from '../../shared/database-types'

// MySQL databases are the browsable schema level; exclude the system catalogs.
// ? = cap.
export const MYSQL_SCHEMAS_SQL = `SELECT schema_name AS name
FROM information_schema.schemata
WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
ORDER BY schema_name
LIMIT ?`

// Tables + views in one schema (database). ? = schema, ? = cap.
export const MYSQL_TABLES_SQL = `SELECT table_name AS name, table_type AS type
FROM information_schema.tables
WHERE table_schema = ?
ORDER BY table_name
LIMIT ?`

// Columns of one table; column_key = 'PRI' marks a primary-key member.
// ? = schema, ? = table.
export const MYSQL_COLUMNS_SQL = `SELECT column_name AS name,
  data_type AS data_type,
  is_nullable AS is_nullable,
  column_key AS column_key
FROM information_schema.columns
WHERE table_schema = ? AND table_name = ?
ORDER BY ordinal_position`

export function mapSchemaRows(rows: { name: string }[]): string[] {
  return rows.map((row) => row.name)
}

export function mapTableRows(rows: { name: string; type: string }[]): DbTable[] {
  // information_schema.table_type is 'BASE TABLE' | 'VIEW' | 'SYSTEM VIEW'.
  return rows.map((row) => ({
    name: row.name,
    kind: row.type.includes('VIEW') ? 'view' : 'table'
  }))
}

export function mapColumnRows(
  rows: {
    name: string
    data_type: string
    is_nullable: string
    column_key: string
  }[]
): DbColumn[] {
  return rows.map((row) => ({
    name: row.name,
    dataType: row.data_type,
    nullable: row.is_nullable === 'YES',
    isPrimaryKey: row.column_key === 'PRI'
  }))
}
