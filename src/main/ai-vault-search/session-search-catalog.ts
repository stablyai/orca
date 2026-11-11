import { sessionSearchCatalogPageRows } from './session-search-catalog-query'
import type SyncDatabase from '../sqlite/sync-database'
import { transitionSessionSearchCatalog } from './session-search-catalog-transition'
import { SessionSearchCatalogStorage } from './session-search-catalog-storage'
import {
  releaseSessionSearchCatalog,
  releaseSessionSearchInventory
} from './session-search-catalog-release'

export const SESSION_SEARCH_CATALOG_PAGE_ROWS = 256
export const SESSION_SEARCH_CATALOG_PAGE_BYTES = 256 * 1024

import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogBaseCommand,
  SessionSearchCatalogResult,
  SessionSearchCatalogRow
} from './session-search-catalog-types'
export type { SessionSearchCatalogCommand, SessionSearchCatalogResult, SessionSearchCatalogRow }

/** Inactive observations and obligations spill to this connection's private scratch catalog. */
export class SessionSearchCatalog extends SessionSearchCatalogStorage {
  private readonly touched = new Set<string>()
  private revision = 0
  constructor(
    db: SyncDatabase,
    readonly requireReason?: (path: string, reason: 'force' | 'metadata') => boolean,
    private readonly effects?: { begin: () => { commit: () => void; rollback: () => void } }
  ) {
    super(db)
  }
  nextRevision(): number {
    return ++this.revision
  }

  transaction<T>(name: string, run: () => T): T {
    const effects = this.effects?.begin()
    let result: T,
      opened = false
    try {
      this.db.exec(`SAVEPOINT ${name}`)
      opened = true
      result = run()
      this.db.exec(`RELEASE ${name}`)
    } catch (error) {
      try {
        if (opened) {
          this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
        }
      } finally {
        effects?.rollback()
      }
      throw error
    }
    effects?.commit()
    return result
  }
  execute(command: SessionSearchCatalogCommand): SessionSearchCatalogResult {
    this.touched.add(command.scope)
    const receipt = command.receipt
    if (!receipt) {
      return this.apply(command)
    }
    const scope = `${command.scope}:input-receipts`
    const previous = this.execute({ kind: 'get', scope, key: receipt.consumer }).rows?.[0]
    if (previous && previous.rank >= receipt.revision) {
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
    return this.transaction('search_input_receipt', () => {
      const result = this.apply({ ...command, receipt: undefined })
      this.execute({
        kind: 'put',
        scope,
        rows: [
          {
            key: receipt.consumer,
            value: JSON.stringify({ result, scopes: [...this.touched] }),
            parent: '',
            group: '',
            rank: receipt.revision,
            ready: 0
          }
        ]
      })
      return result
    })
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
    const result = ['get', 'get-page', 'page', 'count', 'frontier-snapshot'].includes(command.kind)
      ? this.execute(command)
      : this.transaction('search_catalog_accept', () => this.execute(command))
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exhaustive specialized dispatcher returned every non-base operation above.
    const base = command as SessionSearchCatalogBaseCommand
    if (
      (base.kind === 'release' ||
        base.kind === 'release-prefix' ||
        base.kind === 'release-parent') &&
      this.inventory.owner(base.scope)
    ) {
      return releaseSessionSearchInventory(this, base)
    }
    switch (base.kind) {
      case 'release-parent':
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope=? AND parent=?')
          .run(base.scope, base.parent)
        return {}
      case 'get-page': {
        const rows: SessionSearchCatalogRow[] = []
        let bytes = 1024,
          processed = 0
        for (const key of base.keys) {
          const row = this.read(base.scope, key)[0]
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
        if (base.physicalScope && !this.read(`${base.physicalScope}:files`, base.key).length) {
          throw new Error('Session search read has no physical inventory owner')
        }
        return {
          rows: this.read(base.scope, base.key)
        }
      case 'put': {
        if (base.rows.length > SESSION_SEARCH_CATALOG_PAGE_ROWS) {
          throw new Error('Session catalog batch exceeds row budget')
        }
        let bytes = 1024
        for (const row of base.rows) {
          bytes += this.bytes(row)
        }
        if (base.rows.length > 1 && bytes > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
          throw new Error('Session catalog batch exceeds byte budget')
        }
        const owner = this.inventory.owner(base.scope)
        if (owner) {
          const put = () => {
            for (const row of base.rows) {
              this.inventory.put(owner, row)
            }
          }
          if (this.db.isTransaction) {
            put()
          } else {
            this.transaction('search_inventory_page', put)
          }
          return {}
        }
        const put = () => {
          const insert = this.db.prepare(`INSERT INTO temp.search_catalog
            (scope,key,value,parent,group_key,rank,ready,tie) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,
            parent=excluded.parent,group_key=excluded.group_key,rank=excluded.rank,
            ready=excluded.ready,tie=excluded.tie`)
          for (const row of base.rows) {
            insert.run(
              base.scope,
              row.key,
              row.value,
              row.parent,
              row.group,
              row.rank,
              row.ready,
              row.tie ?? 0
            )
          }
        }
        if (this.db.isTransaction) {
          put()
        } else {
          this.transaction('search_catalog_batch', put)
        }
        return {}
      }
      case 'delete-page':
        for (const key of base.keys) {
          this.execute({ kind: 'delete', scope: base.scope, key })
        }
        return {}
      case 'delete':
        if (this.inventory.owner(base.scope)) {
          this.inventory.delete(this.inventory.owner(base.scope)!, base.key)
          return {}
        }
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key = ?')
          .run(base.scope, base.key)
        return {}
      case 'release':
        this.db.prepare('DELETE FROM temp.search_catalog WHERE scope = ?').run(base.scope)
        return {}
      case 'release-scopes-page': {
        return releaseSessionSearchCatalog(this, base)
      }
      case 'release-scopes':
        return releaseSessionSearchCatalog(this, base)
      case 'release-prefix': {
        let count = 0
        this.db
          .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key = ?')
          .run(base.scope, base.prefix)
        count += Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
        for (const separator of ['/', '\\']) {
          const prefix = `${base.prefix}${separator}`
          this.db
            .prepare('DELETE FROM temp.search_catalog WHERE scope = ? AND key >= ? AND key < ?')
            .run(base.scope, prefix, `${prefix}\uffff`)
          count += Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0)
        }
        return { count }
      }
      case 'count': {
        const row = this.db
          .prepare('SELECT n,runnable FROM temp.search_catalog_counts WHERE scope=?')
          .get(base.scope)
        const count = Number(row?.n ?? 0),
          runnable = Number(row?.runnable ?? 0)
        return {
          count: base.ready === undefined ? count : base.ready === 1 ? runnable : count - runnable
        }
      }
      case 'page': {
        const rows: SessionSearchCatalogRow[] = []
        let bytes = 1024
        const iterator = sessionSearchCatalogPageRows(this.db, base)
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
    throw new Error('Unsupported session catalog command')
  }
}
