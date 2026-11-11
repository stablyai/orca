import type SyncDatabase from '../sqlite/sync-database'
import { transitionSessionSearchCatalog } from './session-search-catalog-transition'
import { SessionSearchCatalogStorage } from './session-search-catalog-storage'

export const SESSION_SEARCH_CATALOG_PAGE_ROWS = 256
export const SESSION_SEARCH_CATALOG_PAGE_BYTES = 256 * 1024

import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult,
  SessionSearchCatalogRow
} from './session-search-catalog-types'
export type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult,
  SessionSearchCatalogRow
} from './session-search-catalog-types'

/** Inactive observations and obligations spill to this connection's private scratch catalog. */
export class SessionSearchCatalog extends SessionSearchCatalogStorage {
  private readonly touched = new Set<string>()
  private revision = 0
  constructor(
    db: SyncDatabase,
    readonly requireReason?: (path: string, reason: 'force' | 'metadata') => boolean
  ) {
    super(db)
  }
  nextRevision(): number {
    return ++this.revision
  }

  execute(command: SessionSearchCatalogCommand): SessionSearchCatalogResult {
    this.touched.add(command.scope)
    if (!command.receipt) {
      return this.apply(command)
    }
    const scope = `${command.scope}:input-receipts`
    const previous = this.execute({ kind: 'get', scope, key: command.receipt.consumer }).rows?.[0]
    if (previous && previous.rank >= command.receipt.revision) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this receipt owner encodes the accepted response.
      const accepted = JSON.parse(previous.value) as {
        result: SessionSearchCatalogResult
        scopes: string[]
      }
      for (const touchedScope of accepted.scopes) {
        this.touched.add(touchedScope)
      }
      return accepted.result
    }
    this.db.exec('SAVEPOINT search_input_receipt')
    try {
      const result = this.apply({ ...command, receipt: undefined })
      this.execute({
        kind: 'put',
        scope,
        rows: [
          {
            key: command.receipt.consumer,
            value: JSON.stringify({ result, scopes: [...this.touched] }),
            parent: '',
            group: '',
            rank: command.receipt.revision,
            ready: 0
          }
        ]
      })
      this.db.exec('RELEASE search_input_receipt')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO search_input_receipt; RELEASE search_input_receipt')
      throw error
    }
  }
  response(command: SessionSearchCatalogCommand): SessionSearchCatalogResult {
    const records =
      'rows' in command
        ? command.rows
        : 'keys' in command
          ? command.keys
          : 'inputs' in command
            ? command.inputs
            : 'outcomes' in command
              ? command.outcomes
              : 'receipts' in command
                ? command.receipts
                : 'paths' in command
                  ? command.paths
                  : undefined
    if (
      records &&
      (records.length > SESSION_SEARCH_CATALOG_PAGE_ROWS ||
        (records.length > 1 &&
          JSON.stringify(command).length * 2 > SESSION_SEARCH_CATALOG_PAGE_BYTES))
    ) {
      throw new Error('Session catalog request exceeds page budget')
    }
    this.touched.clear()
    const result = this.execute(command)
    return {
      ...result,
      scopeCounts: [...this.touched].map((scope) => {
        const row = this.db
          .prepare('SELECT n,runnable FROM temp.search_catalog_counts WHERE scope=?')
          .get(scope)
        return [scope, Number(row?.n ?? 0), Number(row?.runnable ?? 0)]
      })
    }
  }
  get connection(): SyncDatabase {
    return this.db
  }
  private apply(command: SessionSearchCatalogCommand): SessionSearchCatalogResult {
    const transitioned = transitionSessionSearchCatalog(this, command)
    if (transitioned) {
      return transitioned
    }
    switch (command.kind) {
      case 'release-parent':
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope=? AND parent=?')
          .run(command.scope, command.parent)
        return {}
      case 'get-page': {
        const rows: SessionSearchCatalogRow[] = []
        let bytes = 1024,
          processed = 0
        for (const key of command.keys) {
          const row = this.read('WHERE scope=? AND key=?', [command.scope, key])[0]
          const size = row ? this.bytes(row) : 0
          if (rows.length && bytes + size > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
            break
          }
          processed++
          if (row) {
            rows.push(row)
          }
          bytes += size
        }
        return { rows, processed }
      }
      case 'get':
        return {
          rows: this.read('WHERE scope = ? AND key = ?', [command.scope, command.key])
        }
      case 'put': {
        if (command.rows.length > SESSION_SEARCH_CATALOG_PAGE_ROWS) {
          throw new Error('Session catalog batch exceeds row budget')
        }
        let bytes = 1024
        for (const row of command.rows) {
          bytes += this.bytes(row)
        }
        if (command.rows.length > 1 && bytes > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
          throw new Error('Session catalog batch exceeds byte budget')
        }
        this.db.exec('SAVEPOINT search_catalog_batch')
        try {
          const insert = this.db.prepare(`INSERT INTO temp.search_catalog
            (scope,key,value,parent,group_key,rank,ready,tie) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,
            parent=excluded.parent,group_key=excluded.group_key,rank=excluded.rank,
            ready=excluded.ready,tie=excluded.tie`)
          for (const row of command.rows) {
            insert.run(
              command.scope,
              row.key,
              row.value,
              row.parent,
              row.group,
              row.rank,
              row.ready,
              row.tie ?? 0
            )
          }
          this.db.exec('RELEASE search_catalog_batch')
        } catch (error) {
          this.db.exec('ROLLBACK TO search_catalog_batch; RELEASE search_catalog_batch')
          throw error
        }
        return {}
      }
      case 'delete-page':
        for (const key of command.keys) {
          this.execute({ kind: 'delete', scope: command.scope, key })
        }
        return {}
      case 'delete':
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key = ?')
          .run(command.scope, command.key)
        return {}
      case 'release':
        this.db.prepare('DELETE FROM temp.search_catalog WHERE scope = ?').run(command.scope)
        return {}
      case 'release-scopes-page': {
        const rows = this.db
          .prepare(
            'SELECT scope,key FROM temp.search_catalog WHERE scope=? OR (scope>=? AND scope<?) ORDER BY scope,key LIMIT 256'
          )
          .all(command.scope, `${command.scope}:`, `${command.scope}:\uffff`)
        for (const row of rows) {
          this.execute({ kind: 'delete', scope: String(row.scope), key: String(row.key) })
        }
        return { count: rows.length }
      }
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
          .prepare('SELECT n,runnable FROM temp.search_catalog_counts WHERE scope=?')
          .get(command.scope)
        const count = Number(row?.n ?? 0),
          runnable = Number(row?.runnable ?? 0)
        return {
          count:
            command.ready === undefined ? count : command.ready === 1 ? runnable : count - runnable
        }
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
        if (command.throughRevision !== undefined) {
          conditions.push('tie <= ?')
          values.push(command.throughRevision)
        }
        if (command.beforeRank !== undefined) {
          conditions.push('rank <= ?')
          values.push(command.beforeRank)
        }
        const rows: SessionSearchCatalogRow[] = []
        let bytes = 1024
        const iterator = this.db
          .prepare(`SELECT key,value,parent,group_key,rank,ready,tie FROM temp.search_catalog
            WHERE ${conditions.join(' AND ')} ORDER BY ${command.orderRevision ? 'tie,key' : command.orderRank ? 'rank,tie,key' : 'key'} LIMIT ?`)
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
      default:
        throw new Error('Unsupported session catalog command')
    }
  }
}
