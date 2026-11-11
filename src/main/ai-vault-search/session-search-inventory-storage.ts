import type { SessionSearchValueRow } from './session-search-value-row'
import { SessionSearchInventoryPage } from './session-search-inventory-page'
import { SessionSearchInventoryMutations } from './session-search-inventory-mutations'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogRow } from './session-search-catalog-types'
import { initializeSessionSearchInventory } from './session-search-inventory-schema'
import {
  SESSION_SEARCH_INVENTORY_MEMBERS,
  sessionSearchInventoryRelation,
  sessionSearchInventoryColumns,
  decodeSessionSearchInventoryValue,
  type SessionSearchInventoryMember
} from './session-search-inventory-relation'

const stores = new WeakMap<SyncDatabase, SessionSearchInventoryStorage>()
export function sessionSearchInventoryStorage(db: SyncDatabase): SessionSearchInventoryStorage {
  let store = stores.get(db)
  if (!store) {
    store = new SessionSearchInventoryStorage(db)
    stores.set(db, store)
  }
  return store
}

export type SessionSearchInventoryOwner = { source: number; member: SessionSearchInventoryMember }

/** Sources are interned once; per-path facts stay exclusively in the writer connection. */
export class SessionSearchInventoryStorage extends SessionSearchInventoryMutations {
  withinPage<T>(run: () => T): T {
    this.flush()
    const previous = this.page
    this.page = new SessionSearchInventoryPage(this.db)
    try {
      const result = run()
      this.flush()
      return result
    } finally {
      this.page = previous
      previous?.clear()
    }
  }
  flush(): void {
    this.page?.flush()
  }
  invalidate(): void {
    this.flush()
    this.page?.clear()
  }
  constructor(db: SyncDatabase) {
    super(db)
    initializeSessionSearchInventory(db)
  }

  open(scope: string, root: string): void {
    this.invalidate()
    this.db
      .prepare(
        'INSERT INTO temp.search_inventory_sources(scope,root) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET root=excluded.root'
      )
      .run(scope, root)
  }
  owner(scope: string): SessionSearchInventoryOwner | undefined {
    const at = scope.lastIndexOf(':')
    const member = SESSION_SEARCH_INVENTORY_MEMBERS.find((value) => value === scope.slice(at + 1))
    if (!member) {
      return undefined
    }
    const sourceScope = scope.slice(0, at)
    if (!this.page?.sources.has(sourceScope)) {
      const row = this.db
        .prepare('SELECT id FROM temp.search_inventory_sources WHERE scope=?')
        .get(sourceScope)
      const source = row ? Number(row.id) : undefined
      this.page?.sources.set(sourceScope, source)
      return source === undefined ? undefined : { source, member }
    }
    const source = this.page.sources.get(sourceScope)
    return source === undefined ? undefined : { source, member }
  }
  select(owner: SessionSearchInventoryOwner): string {
    const relation = sessionSearchInventoryRelation(owner.member)
    return `SELECT ${sessionSearchInventoryColumns(owner.member)},${relation.key} AS projected_key,${relation.parent} AS projected_parent,
      ${relation.group} AS projected_group,${relation.rank} AS projected_rank,
      ${relation.ready} AS projected_ready FROM temp.${relation.table}
      WHERE source=? AND ${relation.present}`
  }
  get(owner: SessionSearchInventoryOwner, key: string): SessionSearchCatalogRow | undefined {
    const row = this.getValue(owner, key)
    if (!row) {
      return undefined
    }
    const { data, ...fields } = row
    return { ...fields, value: JSON.stringify(data) }
  }
  getValue(owner: SessionSearchInventoryOwner, key: string): SessionSearchValueRow | undefined {
    const identity = `${owner.source}:${owner.member}:${key}`
    if (this.page?.rows.has(identity)) {
      return this.page.rows.get(identity)
    }
    const row = this.loadValue(owner, key)
    this.page?.rows.set(identity, row)
    return row
  }
  loadValue(owner: SessionSearchInventoryOwner, key: string): SessionSearchValueRow | undefined {
    const relation = sessionSearchInventoryRelation(owner.member)
    if (
      this.page &&
      (relation.table === 'search_inventory_entries' ||
        relation.table === 'search_inventory_activity')
    ) {
      return this.page.readValue(owner.source, owner.member, key, relation.table)
    }
    const keyColumn = owner.member === 'observation-epochs' ? 'revision' : relation.key
    const raw = this.db.prepare(`${this.select(owner)} AND ${keyColumn}=?`).get(owner.source, key)
    return raw ? decodeSessionSearchInventoryValue(owner.member, raw) : undefined
  }
  minimumFloor(scope: string): number | undefined {
    const owner = this.owner(`${scope}:epochs`)
    if (!owner) {
      return undefined
    }
    return Math.min(
      ...['epochs', 'observation-epochs', 'removal-epochs'].map((kind) => {
        const row = this.db
          .prepare(`SELECT cutoff FROM temp.search_inventory_epochs
        WHERE source=? AND kind=? ORDER BY cutoff LIMIT 1`)
          .get(owner.source, kind)
        return Number(row?.cutoff ?? Infinity)
      })
    )
  }
  deleteStaged(scope: string, parent: string, epoch: string, keys: string[]): boolean {
    const owner = this.owner(scope)
    if (!owner || owner.member !== 'directory-input') {
      return false
    }
    if (!keys.length) {
      return true
    }
    this.db
      .prepare(`DELETE FROM temp.search_inventory_staging
      WHERE source=? AND parent=? AND epoch=? AND path IN (SELECT value FROM json_each(?))`)
      .run(owner.source, parent, epoch, JSON.stringify(keys))
    for (const key of keys) {
      this.page?.rows.delete(`${owner.source}:${owner.member}:${key}`)
    }
    return true
  }
  decode(
    owner: SessionSearchInventoryOwner,
    row: Record<string, unknown>
  ): SessionSearchCatalogRow {
    const value = decodeSessionSearchInventoryValue(owner.member, row)
    this.page?.rows.set(`${owner.source}:${owner.member}:${value.key}`, value)
    const { data, ...fields } = value
    return { ...fields, value: JSON.stringify(data) }
  }
}
