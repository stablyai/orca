import {
  flushSessionSearchPhysical,
  flushSessionSearchEpochs
} from './session-search-inventory-flush'
import { dirname } from 'node:path'
import type { SessionSearchValueRow } from './session-search-value-row'
import type SyncDatabase from '../sqlite/sync-database'
import {
  projectSessionSearchPhysical,
  projectSessionSearchFallback
} from './session-search-inventory-prefetch'
import {
  changeSessionSearchInventoryFloor,
  type SessionSearchEpochIdentity,
  type SessionSearchInventoryFloor
} from './session-search-inventory-floor'
import {
  decodeSessionSearchInventoryValue,
  sessionSearchInventoryColumns,
  type SessionSearchInventoryMember
} from './session-search-inventory-relation'

const physicalMembers = {
  search_inventory_entries: ['files', 'directories'],
  search_inventory_activity: ['authority', 'observing', 'delivery']
} satisfies Record<string, SessionSearchInventoryMember[]>
export type SessionSearchPhysicalTable = keyof typeof physicalMembers
export type SessionSearchPhysicalFields = Record<string, SyncDatabase.BindValue>
export type SessionSearchPhysicalMutation = {
  source: number
  path: string
  parent: string
  fields: SessionSearchPhysicalFields
}
export type SessionSearchPhysicalEpoch = {
  source: number
  revision: number
  path?: string
  cutoff?: number
}
const projections = Object.fromEntries(
  Object.entries(physicalMembers).map(([table, members]) => [
    table,
    [
      ...new Set([
        'parent',
        ...members.flatMap((member) => sessionSearchInventoryColumns(member).split(',')),
        ...(table === 'search_inventory_activity' ? ['reclaimable'] : [])
      ])
    ].join(',')
  ])
)

/** Only physical facts and final column patches survive within synchronous acceptance. */
export class SessionSearchInventoryPage {
  private readonly sources = new Map<string, Record<string, unknown> | undefined>()
  private readonly physical = new Map<string, Record<string, unknown>>()
  private readonly pending = new Map<
    string,
    { table: SessionSearchPhysicalTable } & SessionSearchPhysicalMutation
  >()
  private readonly epochs = new Map<string, SessionSearchPhysicalEpoch>()
  private readonly sizes = new Map<string, number>()
  private readonly fallback = new Map<string, SessionSearchValueRow | undefined>()
  private readonly floors = new Map<number, SessionSearchInventoryFloor>()
  private bytes = 1024
  private queryBytes = 0
  private queryRows = 0
  constructor(private readonly db: SyncDatabase) {}

  private retain(key: string, value: unknown): boolean {
    let retained = true
    // Pending patches reserve their parameter tuples and encoded SQL payload too.
    const copies = key.startsWith('write:') || key.startsWith('epoch:') ? 3 : 1
    const bytes = (JSON.stringify([key, value]).length * 2 + 64) * copies
    const previous = this.sizes.get(key) ?? 0
    if (
      this.sizes.size &&
      (this.sizes.size + this.queryRows + Number(!previous) > 256 ||
        this.bytes - previous + bytes > 256 * 1024)
    ) {
      this.flush()
      this.clear()
      retained = false
    }
    const current = this.sizes.get(key) ?? 0
    this.sizes.set(key, bytes)
    this.bytes += bytes - current
    return retained
  }
  fallbackValue(
    scope: string,
    path: string,
    read: () => SessionSearchValueRow | undefined
  ): SessionSearchValueRow | undefined {
    const key = `fallback:${scope}:${path}`
    if (!this.fallback.has(key)) {
      const row = read()
      this.retain(key, row)
      this.fallback.set(key, row)
    }
    return this.fallback.get(key)
  }
  forgetFallback(scope: string, path: string): void {
    const key = `fallback:${scope}:${path}`
    this.fallback.delete(key)
    this.bytes -= this.sizes.get(key) ?? 0
    this.sizes.delete(key)
  }
  peekFallback(scope: string, path: string): SessionSearchValueRow | undefined {
    return this.fallback.get(`fallback:${scope}:${path}`)
  }
  changeFloor(source: number, epoch?: SessionSearchEpochIdentity, cutoff?: number): void {
    const floor = this.floors.get(source)
    if (floor === undefined) {
      return
    }
    const next = changeSessionSearchInventoryFloor(floor, epoch, cutoff)
    if (!next) {
      this.floors.delete(source)
    } else if (next !== floor && this.retain(`floor:${source}`, next)) {
      this.floors.set(source, next)
    }
  }
  floor(source: number, read: () => SessionSearchInventoryFloor): number {
    const known = this.floors.get(source)
    if (known !== undefined) {
      return known.cutoff
    }
    const value = read()
    if (this.retain(`floor:${source}`, value)) {
      this.floors.set(source, value)
    }
    return value.cutoff
  }
  source(scope: string): Record<string, unknown> | undefined {
    if (!this.sources.has(scope)) {
      const row = this.db
        .prepare('SELECT id,root FROM temp.search_inventory_sources WHERE scope=?')
        .get(scope)
      this.retain(`source:${scope}`, row)
      this.sources.set(scope, row)
    }
    return this.sources.get(scope)
  }
  read(table: SessionSearchPhysicalTable, source: number, path: string): Record<string, unknown> {
    const key = `${table}:${source}:${path}`
    let row = this.physical.get(key)
    if (!row) {
      row = this.db
        .prepare(`SELECT ${projections[table]} FROM temp.${table} WHERE source=? AND path=?`)
        .get(source, path) ?? { path, parent: dirname(path) }
      const pending = this.pending.get(key)
      if (pending) {
        Object.assign(row, { parent: pending.parent }, pending.fields)
      }
      this.retain(`fact:${key}`, row)
      this.physical.set(key, row)
    }
    return row
  }
  prefetch(table: SessionSearchPhysicalTable, source: number, paths: Iterable<string>): void {
    const key = (path: string) => `${table}:${source}:${path}`
    for (const { path, row } of projectSessionSearchPhysical(
      this.db,
      table,
      projections[table],
      source,
      paths,
      (path) => this.physical.has(key(path)),
      (payload, rows) => this.reserveQuery(payload, rows)
    )) {
      const pending = this.pending.get(key(path))
      const value = { ...row, path, parent: row.parent ?? dirname(path), ...pending?.fields }
      this.retain(`fact:${key(path)}`, value)
      this.physical.set(key(path), value)
    }
    this.releaseQuery()
  }
  prefetchFallback(scope: string, paths: Iterable<string>): void {
    const key = (path: string) => `fallback:${scope}:${path}`
    for (const { path, value } of projectSessionSearchFallback(
      this.db,
      scope,
      paths,
      (path) => this.fallback.has(key(path)),
      (payload, rows) => this.reserveQuery(payload, rows)
    )) {
      this.retain(key(path), value)
      this.fallback.set(key(path), value)
    }
    this.releaseQuery()
  }
  private releaseQuery(): void {
    this.bytes -= this.queryBytes
    this.queryBytes = this.queryRows = 0
  }
  private reserveQuery(payload: string, rows: number): void {
    this.releaseQuery()
    this.queryBytes = payload.length * 4 + rows * 128
    this.queryRows = rows
    this.bytes += this.queryBytes
    if (this.sizes.size + rows > 256 || this.bytes > 256 * 1024) {
      this.flush()
      this.clear()
    }
  }
  peek(table: SessionSearchPhysicalTable, source: number, path: string) {
    const key = `${table}:${source}:${path}`
    const row = this.physical.get(key)
    const pending = this.pending.get(key)
    return pending ? { ...row, parent: pending.parent, ...pending.fields } : row
  }
  readValue(
    source: number,
    member: SessionSearchInventoryMember,
    path: string,
    table: SessionSearchPhysicalTable
  ) {
    const row = this.read(table, source, path)
    const present =
      member === 'files'
        ? row.file_revision != null
        : member === 'directories'
          ? row.directory === 1
          : member === 'authority'
            ? row.authority_self != null
            : member === 'observing'
              ? row.observation_authority != null
              : row.delivery_revision != null
    return present
      ? decodeSessionSearchInventoryValue(member, {
          ...row,
          projected_key: path,
          projected_parent: member === 'authority' ? '' : row.parent,
          projected_group: member === 'files' ? (row.dependency ?? '') : '',
          projected_rank: member === 'authority' ? row.authority_tree : 0,
          projected_ready: member === 'authority' ? row.reclaimable : 0
        })
      : undefined
  }
  write(
    table: SessionSearchPhysicalTable,
    source: number,
    path: string,
    fields: SessionSearchPhysicalFields,
    parent = dirname(path)
  ): void {
    const key = `${table}:${source}:${path}`
    const mutation = {
      table,
      source,
      path,
      parent,
      fields: { ...this.pending.get(key)?.fields, ...fields }
    }
    // Reserve first: a flush writes earlier patches before this replacement is staged.
    this.retain(`write:${key}`, mutation)
    this.pending.set(key, mutation)
    const old = this.physical.get(key)
    if (old) {
      const row = { ...old, parent, ...fields }
      this.retain(`fact:${key}`, row)
      this.physical.set(key, row)
    }
  }
  observationEpoch(source: number, revision: number, path?: string, cutoff = revision): void {
    const key = `${source}:${revision}`
    this.changeFloor(
      source,
      { kind: 'observation-epochs', key: revision },
      path === undefined ? undefined : cutoff
    )
    const mutation = { source, revision, path, cutoff }
    this.retain(`epoch:${key}`, mutation)
    this.epochs.set(key, mutation)
  }
  flush(): void {
    flushSessionSearchPhysical(this.db, this.pending)
    this.flushEpochs()
    for (const [key, size] of this.sizes) {
      if (key.startsWith('write:')) {
        this.sizes.delete(key)
        this.bytes -= size
      }
    }
  }
  flushEpochs(): void {
    flushSessionSearchEpochs(this.db, this.epochs)
    for (const [key, size] of this.sizes) {
      if (key.startsWith('epoch:')) {
        this.sizes.delete(key)
        this.bytes -= size
      }
    }
  }
  clear(): void {
    this.physical.clear()
    this.sources.clear()
    this.floors.clear()
    this.fallback.clear()
    this.sizes.clear()
    this.bytes = 1024 + this.queryBytes
  }
}
