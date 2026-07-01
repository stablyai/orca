import { describe, expect, it } from 'vitest'
import {
  mapColumnRows,
  mapSchemaRows,
  mapTableRows,
  MYSQL_COLUMNS_SQL,
  MYSQL_SCHEMAS_SQL,
  MYSQL_TABLES_SQL
} from './mysql-introspection-queries'

describe('mysql introspection SQL', () => {
  it('schemas query excludes system databases and caps via ?', () => {
    expect(MYSQL_SCHEMAS_SQL).toContain('information_schema.schemata')
    expect(MYSQL_SCHEMAS_SQL).toContain(
      "NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')"
    )
    expect(MYSQL_SCHEMAS_SQL).toContain('LIMIT ?')
  })

  it('tables query filters by schema and caps via ?', () => {
    expect(MYSQL_TABLES_SQL).toContain('information_schema.tables')
    expect(MYSQL_TABLES_SQL).toContain('table_schema = ?')
    expect(MYSQL_TABLES_SQL).toContain('LIMIT ?')
  })

  it('columns query selects column_key and filters by schema+table', () => {
    expect(MYSQL_COLUMNS_SQL).toContain('information_schema.columns')
    expect(MYSQL_COLUMNS_SQL).toContain('column_key AS column_key')
    expect(MYSQL_COLUMNS_SQL).toContain('table_schema = ? AND table_name = ?')
    expect(MYSQL_COLUMNS_SQL).toContain('ORDER BY ordinal_position')
  })

  it('uses no window functions (MySQL 5.7 compatible)', () => {
    for (const sql of [MYSQL_SCHEMAS_SQL, MYSQL_TABLES_SQL, MYSQL_COLUMNS_SQL]) {
      expect(sql.toUpperCase()).not.toContain('ROW_NUMBER')
      expect(sql.toUpperCase()).not.toContain('OVER (')
    }
  })
})

describe('mysql row mappers', () => {
  it('maps schema rows to names', () => {
    expect(mapSchemaRows([{ name: 'app' }, { name: 'reporting' }])).toEqual(['app', 'reporting'])
  })

  it('treats BASE TABLE as table and any *VIEW as view', () => {
    expect(
      mapTableRows([
        { name: 't', type: 'BASE TABLE' },
        { name: 'v', type: 'VIEW' },
        { name: 'sv', type: 'SYSTEM VIEW' }
      ])
    ).toEqual([
      { name: 't', kind: 'table' },
      { name: 'v', kind: 'view' },
      { name: 'sv', kind: 'view' }
    ])
  })

  it('maps column_key=PRI to primary key and is_nullable to nullable', () => {
    expect(
      mapColumnRows([
        { name: 'id', data_type: 'int', is_nullable: 'NO', column_key: 'PRI' },
        { name: 'email', data_type: 'varchar', is_nullable: 'YES', column_key: 'UNI' }
      ])
    ).toEqual([
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
      { name: 'email', dataType: 'varchar', nullable: true, isPrimaryKey: false }
    ])
  })
})
