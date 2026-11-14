import { SessionSearchInventoryCapacity } from './session-search-inventory-capacity'
import {
  inventoryPhysicalColumns,
  type SessionSearchAuthorityPhase
} from './session-search-inventory-footprint'
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
  sessionSearchPhysicalValue,
  type SessionSearchInventoryMember
} from './session-search-inventory-relation'

export type SessionSearchPhysicalTable = 'search_inventory_entries' | 'search_inventory_activity'
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
/** Only physical facts and final column patches survive within synchronous acceptance. */
export class SessionSearchInventoryPage {
  private readonly sources = new Map<string, Record<string, unknown> | undefined>()
  private readonly physical = new Map<string, Record<string, unknown>>()
  private readonly pending = new Map<
    string,
    { table: SessionSearchPhysicalTable } & SessionSearchPhysicalMutation
  >()
  private readonly epochs = new Map<string, SessionSearchPhysicalEpoch>()
  private readonly capacity = new SessionSearchInventoryCapacity()
  private readonly fallback = new Map<string, SessionSearchValueRow | undefined>()
  private readonly floors = new Map<number, SessionSearchInventoryFloor>()
  constructor(private readonly db: SyncDatabase) {}

  room() {
    return this.capacity.room()
  }
  beginWorkingSet(
    growth: Map<string, number>,
    source: number,
    epochPaths: readonly string[],
    phase: SessionSearchAuthorityPhase,
    paths: readonly string[],
    scalar: boolean
  ): void {
    this.capacity.beginWorkingSet(growth, source, epochPaths, phase, paths, scalar)
  }
  private retain(key: string, value: unknown): boolean {
    return this.capacity.retain(key, value, () => {
      this.flush()
      if (!this.capacity.phase) {
        this.releaseFacts()
      }
    })
  }
  fallbackValue(
    scope: string,
    path: string,
    read: () => SessionSearchValueRow | undefined,
    held = true
  ): SessionSearchValueRow | undefined {
    const key = `fallback:${scope}:${path}`
    if (!this.fallback.has(key)) {
      const row = read()
      if (this.retain(key, row)) {
        this.fallback.set(key, row)
      } else {
        this.fallback.delete(key)
        this.capacity.transient(held ? key : 'fallback-extra', row)
        return row
      }
    }
    return this.fallback.get(key)
  }
  forgetFallback(scope: string, path: string): void {
    const key = `fallback:${scope}:${path}`
    this.fallback.delete(key)
    this.capacity.delete(key)
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
      this.capacity.delete(`floor:${source}`)
    } else if (next !== floor) {
      if (this.retain(`floor:${source}`, next)) {
        this.floors.set(source, next)
      } else {
        this.floors.delete(source)
      }
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
    if (!this.floors.has(source)) {
      this.capacity.transient(`floor:${source}`, value)
    }
    return value.cutoff
  }
  source(scope: string): Record<string, unknown> | undefined {
    if (!this.sources.has(scope)) {
      const row = this.db
        .prepare('SELECT id,root FROM temp.search_inventory_sources WHERE scope=?')
        .get(scope)
      if (this.retain(`source:${scope}`, row)) {
        this.sources.set(scope, row)
      } else {
        this.capacity.transient(`source:${scope}`, row)
        return row
      }
    }
    return this.sources.get(scope)
  }
  read<T>(
    table: SessionSearchPhysicalTable,
    source: number,
    path: string,
    decode: (row: Record<string, unknown>) => T
  ): T {
    const key = `${table}:${source}:${path}`
    let row = this.physical.get(key)
    if (!row) {
      row = this.db
        .prepare(
          `SELECT ${inventoryPhysicalColumns(table)} FROM temp.${table} WHERE source=? AND path=?`
        )
        .get(source, path) ?? { path, parent: dirname(path) }
      const pending = this.pending.get(key)
      if (pending) {
        Object.assign(row, { parent: pending.parent }, pending.fields)
      }
      if (this.retain(`fact:${key}`, row)) {
        this.physical.set(key, row)
      } else {
        this.physical.delete(key)
      }
    }
    return this.physical.has(key) ? decode(row) : this.capacity.projection.borrow(row, decode)
  }
  releaseTransients(): void {
    this.capacity.releaseTransients()
  }
  prefetch(table: SessionSearchPhysicalTable, source: number, paths: Iterable<string>): boolean {
    const key = (path: string) => `${table}:${source}:${path}`
    this.capacity.projection.projectionComplete = true
    try {
      for (const { path, row } of projectSessionSearchPhysical(
        this.db,
        table,
        inventoryPhysicalColumns(table),
        source,
        paths,
        (path) => this.physical.has(key(path)),
        (payload, rows) => this.capacity.projection.reserveQuery(payload, rows),
        (row) => this.capacity.projection.reserveQueryRow(row)
      )) {
        const pending = this.pending.get(key(path))
        const value = { ...row, path, parent: row.parent ?? dirname(path), ...pending?.fields }
        if (!this.retain(`fact:${key(path)}`, value)) {
          this.physical.delete(key(path))
          this.capacity.projection.refusedProjection(value)
          return false
        }
        this.physical.set(key(path), value)
      }
      return this.capacity.projection.projectionComplete
    } finally {
      this.capacity.projection.releaseQuery()
    }
  }
  prefetchFallback(scope: string, paths: Iterable<string>): boolean {
    const key = (path: string) => `fallback:${scope}:${path}`
    this.capacity.projection.projectionComplete = true
    try {
      for (const { path, value } of projectSessionSearchFallback(
        this.db,
        scope,
        paths,
        (path) => this.fallback.has(key(path)),
        (payload, rows) => this.capacity.projection.reserveQuery(payload, rows),
        (row) => this.capacity.projection.reserveQueryRow(row)
      )) {
        if (!this.retain(key(path), value)) {
          this.fallback.delete(key(path))
          this.capacity.projection.refusedProjection(value)
          return false
        }
        this.fallback.set(key(path), value)
      }
      return this.capacity.projection.projectionComplete
    } finally {
      this.capacity.projection.releaseQuery()
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
    return this.read(table, source, path, (row) => sessionSearchPhysicalValue(member, path, row))
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
      if (this.retain(`fact:${key}`, row)) {
        this.physical.set(key, row)
      } else {
        this.physical.delete(key)
      }
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
    this.capacity.flushedPhysical()
  }
  flushEpochs(): void {
    flushSessionSearchEpochs(this.db, this.epochs)
    this.capacity.flushedEpochs()
  }
  releaseFacts(): void {
    this.physical.clear()
    this.sources.clear()
    this.floors.clear()
    this.fallback.clear()
    this.capacity.releaseFacts()
  }
  clear(): void {
    this.releaseFacts()
  }
}
