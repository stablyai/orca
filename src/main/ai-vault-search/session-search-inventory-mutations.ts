import { dirname } from 'node:path'
import type SyncDatabase from '../sqlite/sync-database'
import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { SessionSearchCatalogRow } from './session-search-catalog-types'
import type { SessionSearchValueRow } from './session-search-value-row'
import type { SessionSearchInventoryOwner } from './session-search-inventory-storage'
import { SESSION_SEARCH_FILE_COLUMNS, sessionSearchFileValues } from './session-search-file-facts'
import { sessionSearchInventoryRelation } from './session-search-inventory-relation'
import type { SessionSearchInventoryPage } from './session-search-inventory-page'

export abstract class SessionSearchInventoryMutations {
  protected page: SessionSearchInventoryPage | undefined
  constructor(readonly db: SyncDatabase) {}
  abstract getValue(
    owner: SessionSearchInventoryOwner,
    key: string
  ): SessionSearchValueRow | undefined
  put(owner: SessionSearchInventoryOwner, row: SessionSearchCatalogRow): void {
    const { value, ...fields } = row
    this.putValue(owner, { ...fields, data: JSON.parse(value) })
  }
  putValue(owner: SessionSearchInventoryOwner, row: SessionSearchValueRow): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matching inventory transition owns each typed value.
    const value = row.data as {
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
    }
    this.page?.rows.set(`${owner.source}:${owner.member}:${row.key}`, row)
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
        const token = String(row.data)
        const [file, dirty, authority]: number[] = JSON.parse(token)
        fields = {
          observation_file: file,
          observation_dirty: dirty,
          observation_authority: authority
        }
        break
      }
      case 'observation-epochs':
        path = String(row.data)
        fields = { kind: owner.member, revision: Number(row.key), cutoff: row.rank, sealed: 0 }
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
    if (relation.table === 'search_inventory_activity' && this.page) {
      this.page.writeActivity(owner.source, path, fields)
      return
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
      relation.table === 'search_inventory_epochs'
        ? owner.member === 'observation-epochs'
          ? 'source,kind,revision'
          : 'source,kind,path'
        : 'source,path'
    const predicate =
      relation.table === 'search_inventory_epochs'
        ? owner.member === 'observation-epochs'
          ? "WHERE kind='observation-epochs'"
          : "WHERE kind<>'observation-epochs'"
        : ''
    this.db
      .prepare(`INSERT INTO temp.${relation.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(${identity}) ${predicate} DO UPDATE SET ${Object.keys(fields)
        .map((column) => `${column}=excluded.${column}`)
        .join(',')}`)
      .run(...values)
  }
  delete(owner: SessionSearchInventoryOwner, key: string): boolean {
    const previous = this.getValue(owner, key)
    if (!previous) {
      return false
    }
    this.page?.rows.set(`${owner.source}:${owner.member}:${key}`, undefined)
    const relation = sessionSearchInventoryRelation(owner.member)
    if (
      owner.member === 'directory-input' ||
      owner.member === 'epochs' ||
      owner.member === 'removal-epochs' ||
      owner.member === 'observation-epochs'
    ) {
      this.db
        .prepare(
          `DELETE FROM temp.${relation.table} WHERE source=? AND ${relation.present} AND ${owner.member === 'observation-epochs' ? 'revision' : 'path'}=?`
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
                : [
                    'delivery_revision',
                    'delivery_removed',
                    'delivery_force',
                    'delivery_metadata',
                    'delivery_authority',
                    ...SESSION_SEARCH_FILE_COLUMNS.map((column) => `delivery_${column}`)
                  ]
      const path = key
      if (relation.table === 'search_inventory_activity' && this.page) {
        this.page.writeActivity(
          owner.source,
          path,
          Object.fromEntries(fields.map((name) => [name, null]))
        )
        return true
      }
      this.db
        .prepare(
          `UPDATE temp.${relation.table} SET ${fields.map((column) => `${column}=${column === 'directory' ? '0' : 'NULL'}`).join(',')} WHERE source=? AND path=?`
        )
        .run(owner.source, path)
      const empty =
        relation.table === 'search_inventory_entries'
          ? 'file_revision IS NULL AND directory=0'
          : 'authority_self IS NULL AND observation_authority IS NULL AND delivery_revision IS NULL'
      this.db
        .prepare(`DELETE FROM temp.${relation.table} WHERE source=? AND path=? AND ${empty}`)
        .run(owner.source, path)
    }
    return true
  }
}
