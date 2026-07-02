import { describe, expect, it } from 'vitest'
import {
  mapColumnRows,
  mapSchemaRows,
  mapTableRows,
  PG_COLUMNS_SQL,
  PG_SCHEMAS_SQL,
  PG_TABLES_SQL
} from './postgres-introspection-queries'

describe('postgres introspection SQL', () => {
  it('schemas query excludes system namespaces and caps via $1', () => {
    expect(PG_SCHEMAS_SQL).toContain('information_schema.schemata')
    expect(PG_SCHEMAS_SQL).toContain("NOT IN ('pg_catalog', 'information_schema')")
    expect(PG_SCHEMAS_SQL).toContain("NOT LIKE 'pg_%'")
    expect(PG_SCHEMAS_SQL).toContain('LIMIT $1')
  })

  it('tables query filters by schema ($1) and caps via $2', () => {
    expect(PG_TABLES_SQL).toContain('information_schema.tables')
    expect(PG_TABLES_SQL).toContain('table_schema = $1')
    expect(PG_TABLES_SQL).toContain('LIMIT $2')
  })

  it('columns query joins primary-key membership and filters by schema+table', () => {
    expect(PG_COLUMNS_SQL).toContain('information_schema.columns')
    expect(PG_COLUMNS_SQL).toContain("constraint_type = 'PRIMARY KEY'")
    expect(PG_COLUMNS_SQL).toContain('c.table_schema = $1 AND c.table_name = $2')
    expect(PG_COLUMNS_SQL).toContain('ORDER BY c.ordinal_position')
  })
})

describe('postgres row mappers', () => {
  it('maps schema rows to names', () => {
    expect(mapSchemaRows([{ name: 'public' }, { name: 'app' }])).toEqual(['public', 'app'])
  })

  it('maps table_type to table/view kind', () => {
    expect(
      mapTableRows([
        { name: 't', type: 'BASE TABLE' },
        { name: 'v', type: 'VIEW' }
      ])
    ).toEqual([
      { name: 't', kind: 'table' },
      { name: 'v', kind: 'view' }
    ])
  })

  it('maps column rows including nullability and primary key', () => {
    expect(
      mapColumnRows([
        { name: 'id', data_type: 'integer', is_nullable: 'NO', is_primary_key: true },
        { name: 'note', data_type: 'text', is_nullable: 'YES', is_primary_key: false }
      ])
    ).toEqual([
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'note', dataType: 'text', nullable: true, isPrimaryKey: false }
    ])
  })
})
