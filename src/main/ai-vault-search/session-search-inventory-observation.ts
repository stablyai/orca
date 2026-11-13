import type SyncDatabase from '../sqlite/sync-database'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import type { SessionSearchCatalogRow } from './session-search-catalog-types'
import type { SessionSearchInventoryStorage } from './session-search-inventory-storage'
import type { SessionSearchObservedFacts } from './session-search-observation-types'
import {
  SESSION_SEARCH_FILE_COLUMNS,
  sessionSearchFileFacts,
  sessionSearchFileValues
} from './session-search-file-facts'

type Authority = { self: number; tree: number; ready: number }
export type SessionSearchObservedDelivery = {
  file?: SessionSearchObservedFacts['file']
  removed?: boolean
  force: boolean
  metadata?: boolean
  revision: number
  authority?: number
}

/** A source-bound view of the existing inventory page, never retained across I/O. */
export class SessionSearchInventoryObservation {
  constructor(
    private readonly storage: SessionSearchInventoryStorage,
    readonly source: number,
    readonly root: string
  ) {}
  directory(path: string): boolean {
    return this.storage.readPhysical('search_inventory_entries', this.source, path).directory === 1
  }
  removeDirectory(path: string): void {
    this.storage.writePhysical('search_inventory_entries', this.source, path, { directory: 0 })
  }
  private paths(sql: string, values: SyncDatabase.BindValue[]): string[] {
    this.storage.flush()
    return boundedSessionSearchPage(this.storage.db.prepare(sql).iterate(...values), (row) =>
      String(row.path)
    )
  }
  filesPage(parent: string, after = ''): string[] {
    return this.paths(
      `SELECT path FROM temp.search_inventory_entries
      WHERE source=? AND parent=? AND path>? AND file_revision IS NOT NULL ORDER BY path LIMIT 256`,
      [this.source, parent, after]
    )
  }
  filesByDependency(dependency: string, after = '', limit = 256): string[] {
    return this.paths(
      `SELECT path FROM temp.search_inventory_entries
      WHERE source=? AND dependency=? AND path>? AND file_revision IS NOT NULL ORDER BY path LIMIT ?`,
      [this.source, dependency, after, Math.min(limit, 256)]
    )
  }
  directoryChildren(parent: string, after = ''): string[] {
    return this.paths(
      `SELECT path FROM temp.search_inventory_entries
      WHERE source=? AND parent=? AND path>? AND directory=1 ORDER BY path LIMIT 256`,
      [this.source, parent, after]
    )
  }
  readyAuthority(beforeRank: number): string[] {
    return this.paths(
      `SELECT path FROM temp.search_inventory_activity
      WHERE source=? AND reclaimable=1 AND authority_tree<=? AND authority_self IS NOT NULL
      ORDER BY authority_tree,path LIMIT 256`,
      [this.source, beforeRank]
    )
  }
  staged(paths: string[], epoch: number): Map<string, { file: boolean; directory: boolean }> {
    const rows = this.storage.db
      .prepare(`SELECT path,file,directory FROM temp.search_inventory_staging
      WHERE source=? AND epoch=? AND path IN (SELECT value FROM json_each(?))`)
      .all(this.source, String(epoch), JSON.stringify(paths))
    return new Map(
      rows.map((row) => [
        String(row.path),
        { file: row.file === 1, directory: row.directory === 1 }
      ])
    )
  }
  stagedPage(parent: string, epoch: number, after = '', limit = 256) {
    const rows = this.storage.db
      .prepare(`SELECT path,file,directory FROM temp.search_inventory_staging
      WHERE source=? AND parent=? AND epoch=? AND path>? ORDER BY path LIMIT ?`)
      .iterate(this.source, parent, String(epoch), after, limit)
    return boundedSessionSearchPage(rows, (row) => ({
      key: String(row.path),
      file: row.file === 1,
      directory: row.directory === 1
    }))
  }
  stage(parent: string, epoch: number, rows: SessionSearchCatalogRow[]): void {
    const values = rows.map((row) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing directory transport encodes these two entry flags.
      const value = JSON.parse(row.value) as { file?: boolean; directory?: boolean }
      return [
        row.key,
        value.file === undefined ? null : Number(value.file),
        value.directory === undefined ? null : Number(value.directory)
      ]
    })
    this.storage.db
      .prepare(`INSERT INTO temp.search_inventory_staging(source,parent,epoch,path,file,directory)
      SELECT ?,?,?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)
      WHERE true ON CONFLICT(source,path) DO UPDATE SET parent=excluded.parent,epoch=excluded.epoch,file=excluded.file,directory=excluded.directory`)
      .run(this.source, parent, String(epoch), JSON.stringify(values))
  }
  directoryEpoch(path: string) {
    return this.storage.directoryEpoch(this.source, path)
  }
  putDirectoryEpoch(
    path: string,
    value?: { revision: number; cutoff: number; sealed: boolean }
  ): void {
    this.storage.putDirectoryEpoch(this.source, path, value)
  }
  removalEpoch(path: string, cutoff?: number): void {
    this.storage.removalEpoch(this.source, path, cutoff)
  }
  file(path: string): SessionSearchObservedFacts | undefined {
    const row = this.storage.readPhysical('search_inventory_entries', this.source, path)
    return row.file_revision == null
      ? undefined
      : {
          revision: Number(row.file_revision),
          file: sessionSearchFileFacts(row, path),
          ...(row.dependency == null ? {} : { dependency: String(row.dependency) })
        }
  }
  putFile(path: string, value?: SessionSearchObservedFacts): void {
    const facts = value
      ? sessionSearchFileValues(value.file)
      : SESSION_SEARCH_FILE_COLUMNS.map(() => null)
    this.storage.writePhysical('search_inventory_entries', this.source, path, {
      file_revision: value?.revision ?? null,
      dependency: value?.dependency ?? null,
      ...Object.fromEntries(
        SESSION_SEARCH_FILE_COLUMNS.map((column, index) => [column, facts[index] ?? null])
      )
    })
  }
  ensureDirectory(path: string): void {
    if (this.storage.readPhysical('search_inventory_entries', this.source, path).directory === 1) {
      return
    }
    this.storage.writePhysical('search_inventory_entries', this.source, path, { directory: 1 })
  }
  authority(path: string): Authority | undefined {
    const row = this.storage.readPhysical('search_inventory_activity', this.source, path)
    return row.authority_self == null
      ? undefined
      : {
          self: Number(row.authority_self),
          tree: Number(row.authority_tree),
          ready: Number(row.reclaimable)
        }
  }
  putAuthority(path: string, value?: Authority): void {
    this.storage.writePhysical('search_inventory_activity', this.source, path, {
      authority_self: value?.self ?? null,
      authority_tree: value?.tree ?? null,
      reclaimable: value?.ready ?? null
    })
  }
  claimed(path: string): boolean {
    const row = this.storage.peekPhysical('search_inventory_activity', this.source, path)
    return row?.observation_authority != null || row?.delivery_revision != null
  }
  observing(path: string): string | undefined {
    const row = this.storage.readPhysical('search_inventory_activity', this.source, path)
    return row.observation_authority == null
      ? undefined
      : JSON.stringify([
          Number(row.observation_file),
          Number(row.observation_dirty),
          Number(row.observation_authority)
        ])
  }
  putObserving(path: string, token?: string): void {
    const parts: number[] = token === undefined ? [] : JSON.parse(token)
    this.storage.writePhysical('search_inventory_activity', this.source, path, {
      observation_file: parts[0] ?? null,
      observation_dirty: parts[1] ?? null,
      observation_authority: parts[2] ?? null
    })
  }
  delivery(path: string): SessionSearchObservedDelivery | undefined {
    const row = this.storage.readPhysical('search_inventory_activity', this.source, path)
    return row.delivery_revision == null
      ? undefined
      : {
          ...(row.delivery_mtime == null
            ? {}
            : { file: sessionSearchFileFacts(row, path, 'delivery_') }),
          ...(row.delivery_removed == null ? {} : { removed: row.delivery_removed === 1 }),
          force: row.delivery_force === 1,
          ...(row.delivery_metadata == null ? {} : { metadata: row.delivery_metadata === 1 }),
          revision: Number(row.delivery_revision),
          ...(row.delivery_authority == null ? {} : { authority: Number(row.delivery_authority) })
        }
  }
  putDelivery(path: string, value?: SessionSearchObservedDelivery): void {
    const facts = value?.file
      ? sessionSearchFileValues(value.file)
      : SESSION_SEARCH_FILE_COLUMNS.map(() => null)
    this.storage.writePhysical('search_inventory_activity', this.source, path, {
      delivery_revision: value?.revision ?? null,
      delivery_removed: value?.removed === undefined ? null : Number(value.removed),
      delivery_force: value === undefined ? null : Number(value.force),
      delivery_metadata: value?.metadata === undefined ? null : Number(value.metadata),
      delivery_authority: value?.authority ?? null,
      ...Object.fromEntries(
        SESSION_SEARCH_FILE_COLUMNS.map((column, index) => [
          `delivery_${column}`,
          facts[index] ?? null
        ])
      )
    })
  }
  epoch(revision: number, path?: string): void {
    this.storage.observationEpoch(this.source, revision, path)
  }
}
