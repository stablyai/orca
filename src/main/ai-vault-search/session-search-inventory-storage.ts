import type { SessionSearchValueRow } from './session-search-value-row'
import { SessionSearchInventoryObservation } from './session-search-inventory-observation'
import type {
  SessionSearchPhysicalTable,
  SessionSearchPhysicalFields
} from './session-search-inventory-page'
import { SessionSearchInventoryPage } from './session-search-inventory-page'
import { SessionSearchInventoryMutations } from './session-search-inventory-mutations'
import {
  sessionSearchEpochIdentity,
  type SessionSearchInventoryFloor
} from './session-search-inventory-floor'
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
    const row = this.page
      ? this.page.source(sourceScope)
      : this.db
          .prepare('SELECT id,root FROM temp.search_inventory_sources WHERE scope=?')
          .get(sourceScope)
    return row ? { source: Number(row.id), member } : undefined
  }

  fallbackValue(scope: string, path: string, read: () => SessionSearchValueRow | undefined) {
    return this.page ? this.page.fallbackValue(scope, path, read) : read()
  }
  forgetFallback(scope: string, path: string): void {
    this.page?.forgetFallback(scope, path)
  }
  peekFallback(scope: string, path: string): SessionSearchValueRow | undefined {
    return this.page?.peekFallback(scope, path)
  }
  peekPhysical(table: SessionSearchPhysicalTable, source: number, path: string) {
    return this.page?.peek(table, source, path)
  }
  observation(scope: string): SessionSearchInventoryObservation | undefined {
    const row = this.page
      ? this.page.source(scope)
      : this.db
          .prepare('SELECT id,root FROM temp.search_inventory_sources WHERE scope=?')
          .get(scope)
    return row
      ? new SessionSearchInventoryObservation(this, Number(row.id), String(row.root))
      : undefined
  }
  readPhysical(table: SessionSearchPhysicalTable, source: number, path: string) {
    return (this.page ?? new SessionSearchInventoryPage(this.db)).read(table, source, path)
  }
  writePhysical(
    table: SessionSearchPhysicalTable,
    source: number,
    path: string,
    fields: SessionSearchPhysicalFields
  ): void {
    const page = this.page ?? new SessionSearchInventoryPage(this.db)
    page.write(table, source, path, fields)
    if (!this.page) {
      page.flush()
    }
  }
  observationEpoch(source: number, revision: number, path?: string): void {
    const page = this.page ?? new SessionSearchInventoryPage(this.db)
    page.observationEpoch(source, revision, path)
    if (!this.page) {
      page.flush()
    }
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
    return this.loadValue(owner, key)
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
    this.flush()
    const keyColumn = owner.member === 'observation-epochs' ? 'revision' : relation.key
    const raw = this.db.prepare(`${this.select(owner)} AND ${keyColumn}=?`).get(owner.source, key)
    return raw ? decodeSessionSearchInventoryValue(owner.member, raw) : undefined
  }
  minimumFloor(scope: string): number | undefined {
    const owner = this.owner(`${scope}:epochs`)
    if (!owner) {
      return undefined
    }
    const read = () => {
      this.page?.flushEpochs()
      let floor: SessionSearchInventoryFloor = { cutoff: Infinity }
      for (const kind of ['epochs', 'observation-epochs', 'removal-epochs'] as const) {
        const row = this.db
          .prepare(`SELECT cutoff,revision,path FROM temp.search_inventory_epochs
          WHERE source=? AND kind=? ORDER BY cutoff LIMIT 1`)
          .get(owner.source, kind)
        if (row && Number(row.cutoff) < floor.cutoff) {
          floor = {
            cutoff: Number(row.cutoff),
            epoch: sessionSearchEpochIdentity(
              kind,
              String(kind === 'observation-epochs' ? row.revision : row.path)
            )
          }
        }
      }
      return floor
    }
    return this.page ? this.page.floor(owner.source, read) : read().cutoff
  }
  reclaimAuthority(scope: string, rows: SessionSearchCatalogRow[]): boolean {
    this.invalidate()
    const owner = this.owner(`${scope}:authority`)
    if (!owner) {
      return false
    }
    if (!rows.length) {
      return true
    }
    const keys = JSON.stringify(rows.map((row) => row.key))
    this.db
      .prepare(`WITH live AS MATERIALIZED (
      SELECT a.path,(a.observation_authority IS NOT NULL OR a.delivery_revision IS NOT NULL
        OR EXISTS(SELECT 1 FROM temp.search_catalog WHERE scope=? AND key=a.path)
        OR EXISTS(SELECT 1 FROM temp.search_catalog WHERE scope=? AND key=a.path)
        OR EXISTS(SELECT 1 FROM temp.search_catalog WHERE scope=? AND key=a.path)) AS claimed
      FROM json_each(?) requested CROSS JOIN temp.search_inventory_activity a
      WHERE a.source=? AND a.path=requested.value
    ) UPDATE temp.search_inventory_activity SET
      authority_self=CASE WHEN live.claimed THEN authority_self ELSE NULL END,
      authority_tree=CASE WHEN live.claimed THEN authority_tree ELSE NULL END,
      reclaimable=CASE WHEN live.claimed THEN 0 ELSE NULL END
      FROM live WHERE source=? AND search_inventory_activity.path=live.path AND authority_self IS NOT NULL`)
      .run(
        `${scope}:dirty`,
        `${scope}:refusals`,
        `${scope}:file-refusals`,
        keys,
        owner.source,
        owner.source
      )
    this.db
      .prepare(`DELETE FROM temp.search_inventory_activity WHERE source=?
      AND path IN (SELECT value FROM json_each(?))
      AND authority_self IS NULL AND observation_authority IS NULL AND delivery_revision IS NULL`)
      .run(owner.source, keys)
    this.page?.clear()
    return true
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
    return true
  }
  decode(
    owner: SessionSearchInventoryOwner,
    row: Record<string, unknown>
  ): SessionSearchCatalogRow {
    const value = decodeSessionSearchInventoryValue(owner.member, row)
    const { data, ...fields } = value
    return { ...fields, value: JSON.stringify(data) }
  }
}
