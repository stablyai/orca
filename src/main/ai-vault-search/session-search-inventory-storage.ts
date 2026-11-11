import { dirname } from 'node:path'
import type SyncDatabase from '../sqlite/sync-database'
import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { SessionSearchCatalogRow } from './session-search-catalog-types'
import { initializeSessionSearchInventory } from './session-search-inventory-schema'
import { SESSION_SEARCH_FILE_COLUMNS, sessionSearchFileValues } from './session-search-file-facts'
import {
  SESSION_SEARCH_INVENTORY_MEMBERS,
  sessionSearchInventoryRelation,
  decodeSessionSearchInventoryRow,
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
export class SessionSearchInventoryStorage {
  constructor(readonly db: SyncDatabase) {
    initializeSessionSearchInventory(db)
  }

  open(scope: string, root: string): void {
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
    const source = this.db
      .prepare('SELECT id FROM temp.search_inventory_sources WHERE scope=?')
      .get(scope.slice(0, at))
    return source ? { source: Number(source.id), member } : undefined
  }
  select(owner: SessionSearchInventoryOwner): string {
    const relation = sessionSearchInventoryRelation(owner.member)
    return `SELECT *,${relation.key} AS projected_key,${relation.parent} AS projected_parent,
      ${relation.group} AS projected_group,${relation.rank} AS projected_rank,
      ${relation.ready} AS projected_ready FROM temp.${relation.table}
      WHERE source=? AND ${relation.present}`
  }
  get(owner: SessionSearchInventoryOwner, key: string): SessionSearchCatalogRow | undefined {
    const relation = sessionSearchInventoryRelation(owner.member)
    const keyColumn = owner.member === 'observation-epochs' ? 'observation_epoch' : relation.key
    const row = this.db.prepare(`${this.select(owner)} AND ${keyColumn}=?`).get(owner.source, key)
    return row ? decodeSessionSearchInventoryRow(owner.member, row) : undefined
  }
  decode(
    owner: SessionSearchInventoryOwner,
    row: Record<string, unknown>
  ): SessionSearchCatalogRow {
    return decodeSessionSearchInventoryRow(owner.member, row)
  }
  put(owner: SessionSearchInventoryOwner, row: SessionSearchCatalogRow): void {
    const value: {
      file?: Omit<FileWithMtime, 'modifiedAt'>
      revision?: number
      dependency?: string
      directory?: boolean
      self?: number
      tree?: number
      cutoff?: number
      sealed?: boolean
      removed?: boolean
      force?: boolean
      metadata?: boolean
      authority?: number
    } = JSON.parse(row.value)
    const relation = sessionSearchInventoryRelation(owner.member)
    let fields: Record<string, SyncDatabase.BindValue> = {}
    let path = row.key
    switch (owner.member) {
      case 'files': {
        const facts = sessionSearchFileValues(value.file!)
        fields = {
          file_revision: value.revision ?? 0,
          dependency: value.dependency ?? null,
          ...Object.fromEntries(SESSION_SEARCH_FILE_COLUMNS.map((column, n) => [column, facts[n]!]))
        }
        break
      }
      case 'directories':
        fields = { directory: 1 }
        break
      case 'directory-input':
        fields = {
          epoch: row.group,
          file: value.file === undefined ? null : Number(value.file),
          directory: value.directory === undefined ? null : Number(value.directory)
        }
        break
      case 'authority':
        fields = {
          authority_self: value.self ?? 0,
          authority_tree: value.tree ?? 0,
          reclaimable: row.ready
        }
        break
      case 'observing': {
        const token: string = JSON.parse(row.value)
        const [file, dirty, authority]: number[] = JSON.parse(token)
        fields = {
          observation_file: file,
          observation_dirty: dirty,
          observation_authority: authority
        }
        break
      }
      case 'observation-epochs':
        path = JSON.parse(row.value)
        fields = { observation_epoch: Number(row.key) }
        break
      case 'epochs':
        fields = {
          kind: owner.member,
          revision: value.revision ?? 0,
          cutoff: value.cutoff ?? row.rank,
          sealed: Number(value.sealed)
        }
        break
      case 'removal-epochs':
        fields = { kind: owner.member, revision: row.rank, cutoff: row.rank, sealed: 0 }
        break
      case 'delivery': {
        const facts = value.file
          ? sessionSearchFileValues(value.file)
          : SESSION_SEARCH_FILE_COLUMNS.map(() => null)
        fields = {
          delivery_revision: value.revision ?? 0,
          delivery_removed: value.removed === undefined ? null : Number(value.removed),
          delivery_force: Number(value.force ?? false),
          delivery_metadata: value.metadata === undefined ? null : Number(value.metadata),
          delivery_authority: value.authority ?? null,
          ...Object.fromEntries(
            SESSION_SEARCH_FILE_COLUMNS.map((column, n) => [`delivery_${column}`, facts[n]])
          )
        }
        break
      }
    }
    const parent = relation.table === 'search_inventory_activity' ? dirname(path) : row.parent
    const columns = [
      'source',
      'path',
      ...(relation.table === 'search_inventory_epochs' ? [] : ['parent']),
      ...Object.keys(fields)
    ]
    const values = [
      owner.source,
      path,
      ...(relation.table === 'search_inventory_epochs' ? [] : [parent]),
      ...Object.values(fields)
    ]
    const identity =
      relation.table === 'search_inventory_epochs' ? 'source,kind,path' : 'source,path'
    this.db
      .prepare(`INSERT INTO temp.${relation.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(${identity}) DO UPDATE SET ${Object.keys(fields)
        .map((column) => `${column}=excluded.${column}`)
        .join(',')}`)
      .run(...values)
  }
  delete(owner: SessionSearchInventoryOwner, key: string): boolean {
    const previous = this.get(owner, key)
    if (!previous) {
      return false
    }
    const relation = sessionSearchInventoryRelation(owner.member)
    if (
      owner.member === 'directory-input' ||
      owner.member === 'epochs' ||
      owner.member === 'removal-epochs'
    ) {
      this.db
        .prepare(
          `DELETE FROM temp.${relation.table} WHERE source=? AND ${relation.present} AND path=?`
        )
        .run(owner.source, key)
    } else {
      const fields =
        owner.member === 'files'
          ? [
              'file_revision',
              'mtime',
              'size',
              'dev',
              'ino',
              'nlink',
              'alias_mtime',
              'sidecar',
              'dependency'
            ]
          : owner.member === 'directories'
            ? ['directory']
            : owner.member === 'authority'
              ? ['authority_self', 'authority_tree', 'reclaimable']
              : owner.member === 'observing'
                ? ['observation_file', 'observation_dirty', 'observation_authority']
                : owner.member === 'observation-epochs'
                  ? ['observation_epoch']
                  : [
                      'delivery_revision',
                      'delivery_removed',
                      'delivery_force',
                      'delivery_metadata',
                      'delivery_authority',
                      ...SESSION_SEARCH_FILE_COLUMNS.map((column) => `delivery_${column}`)
                    ]
      const path = owner.member === 'observation-epochs' ? JSON.parse(previous.value) : key
      this.db
        .prepare(
          `UPDATE temp.${relation.table} SET ${fields.map((column) => `${column}=${column === 'directory' ? '0' : 'NULL'}`).join(',')} WHERE source=? AND path=?`
        )
        .run(owner.source, path)
      const empty =
        relation.table === 'search_inventory_entries'
          ? 'file_revision IS NULL AND directory=0'
          : 'authority_self IS NULL AND observation_authority IS NULL AND observation_epoch IS NULL AND delivery_revision IS NULL'
      this.db
        .prepare(`DELETE FROM temp.${relation.table} WHERE source=? AND path=? AND ${empty}`)
        .run(owner.source, path)
    }
    return true
  }
}
