import type SyncDatabase from '../sqlite/sync-database'

export const SESSION_SEARCH_CATALOG_PAGE_ROWS = 256
export const SESSION_SEARCH_CATALOG_PAGE_BYTES = 256 * 1024

export type SessionSearchCatalogRow = {
  key: string
  value: string
  parent: string
  group: string
  rank: number
  ready: number
}
export type SessionSearchCatalogCommand =
  | { kind: 'get'; scope: string; key: string }
  | { kind: 'put'; scope: string; rows: SessionSearchCatalogRow[] }
  | { kind: 'delete'; scope: string; key: string }
  | { kind: 'release'; scope: string }
  | { kind: 'release-scopes'; scope: string }
  | { kind: 'release-prefix'; scope: string; prefix: string }
  | { kind: 'count'; scope: string; ready?: number }
  | {
      kind: 'page'
      scope: string
      after?: string
      parent?: string
      group?: string
      ready?: number
      orderRank?: boolean
      limit?: number
      prefix?: string
    }
export type SessionSearchCatalogResult = {
  rows?: SessionSearchCatalogRow[]
  count?: number
  after?: string
}

/** Inactive observations and obligations spill to this connection's private scratch catalog. */
export class SessionSearchCatalog {
  constructor(private readonly db: SyncDatabase) {
    db.exec(`PRAGMA temp_store = FILE;
      PRAGMA temp.cache_size = -1024;
      CREATE TEMP TABLE search_catalog (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        parent TEXT NOT NULL, group_key TEXT NOT NULL, rank REAL NOT NULL,
        ready INTEGER NOT NULL, PRIMARY KEY(scope,key)
      ) WITHOUT ROWID;
      CREATE INDEX temp.search_catalog_parent ON search_catalog(scope,parent,key);
      CREATE INDEX temp.search_catalog_group ON search_catalog(scope,group_key,key);
      CREATE INDEX temp.search_catalog_queue ON search_catalog(scope,group_key,rank,key);
      CREATE INDEX temp.search_catalog_ready ON search_catalog(scope,ready,key)`)
  }

  execute(command: SessionSearchCatalogCommand): SessionSearchCatalogResult {
    switch (command.kind) {
      case 'get':
        return {
          rows: this.read('WHERE scope = ? AND key = ?', [command.scope, command.key])
        }
      case 'put': {
        if (command.rows.length > SESSION_SEARCH_CATALOG_PAGE_ROWS) {
          throw new Error('Session catalog batch exceeds row budget')
        }
        let bytes = 0
        for (const row of command.rows) {
          bytes += this.bytes(row)
        }
        if (command.rows.length > 1 && bytes > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
          throw new Error('Session catalog batch exceeds byte budget')
        }
        this.db.exec('SAVEPOINT search_catalog_batch')
        try {
          const insert = this.db.prepare(`INSERT INTO temp.search_catalog
            (scope,key,value,parent,group_key,rank,ready) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,
            parent=excluded.parent,group_key=excluded.group_key,rank=excluded.rank,
            ready=excluded.ready`)
          for (const row of command.rows) {
            insert.run(
              command.scope,
              row.key,
              row.value,
              row.parent,
              row.group,
              row.rank,
              row.ready
            )
          }
          this.db.exec('RELEASE search_catalog_batch')
        } catch (error) {
          this.db.exec('ROLLBACK TO search_catalog_batch; RELEASE search_catalog_batch')
          throw error
        }
        return {}
      }
      case 'delete':
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key = ?')
          .run(command.scope, command.key)
        return {}
      case 'release':
        this.db.prepare('DELETE FROM temp.search_catalog WHERE scope = ?').run(command.scope)
        return {}
      case 'release-scopes':
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? OR (scope >= ? AND scope < ?)')
          .run(command.scope, `${command.scope}:`, `${command.scope}:\uffff`)
        return {}
      case 'release-prefix': {
        let count = 0
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key = ?')
          .run(command.scope, command.prefix)
        count += Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
        for (const separator of ['/', '\\']) {
          const prefix = `${command.prefix}${separator}`
          this.db
            .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key >= ? AND key < ?')
            .run(command.scope, prefix, `${prefix}\uffff`)
          count += Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
        }
        return { count }
      }
      case 'count': {
        const row = this.db
          .prepare(`SELECT count(*) AS count FROM temp.search_catalog
            WHERE scope = ?${command.ready === undefined ? '' : ' AND ready = ?'}`)
          .get(...(command.ready === undefined ? [command.scope] : [command.scope, command.ready]))
        return { count: Number(row?.count ?? 0) }
      }
      case 'page': {
        const conditions = ['scope = ?', 'key > ?']
        const values: (string | number)[] = [command.scope, command.after ?? '']
        if (command.prefix !== undefined) {
          conditions.push('key >= ?', 'key < ?')
          values.push(command.prefix, `${command.prefix}\uffff`)
        }
        for (const [column, value] of [
          ['parent', command.parent],
          ['group_key', command.group],
          ['ready', command.ready]
        ] as const) {
          if (value !== undefined) {
            conditions.push(`${column} = ?`)
            values.push(value)
          }
        }
        const rows: SessionSearchCatalogRow[] = []
        let bytes = 0
        const iterator = this.db
          .prepare(`SELECT key,value,parent,group_key,rank,ready FROM temp.search_catalog
            WHERE ${conditions.join(' AND ')} ORDER BY ${command.orderRank ? 'rank,key' : 'key'} LIMIT ?`)
          .iterate(
            ...values,
            Math.max(
              1,
              Math.min(
                command.limit ?? SESSION_SEARCH_CATALOG_PAGE_ROWS,
                SESSION_SEARCH_CATALOG_PAGE_ROWS
              )
            )
          )
        for (const value of iterator) {
          const row = this.decode(value)
          const next = this.bytes(row)
          if (rows.length && bytes + next > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
            break
          }
          rows.push(row)
          bytes += next
        }
        return { rows, after: rows.at(-1)?.key }
      }
    }
  }

  private read(where: string, values: string[]): SessionSearchCatalogRow[] {
    return this.db
      .prepare(`SELECT key,value,parent,group_key,rank,ready FROM temp.search_catalog ${where}`)
      .all(...values)
      .map((row) => this.decode(row))
  }

  private decode(row: Record<string, unknown>): SessionSearchCatalogRow {
    return {
      key: String(row.key),
      value: String(row.value),
      parent: String(row.parent),
      group: String(row.group_key),
      rank: Number(row.rank),
      ready: Number(row.ready)
    }
  }

  private bytes(row: SessionSearchCatalogRow): number {
    return (row.key.length + row.value.length + row.parent.length + row.group.length) * 2 + 64
  }
}
