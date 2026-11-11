import { dirname } from 'node:path'
import type { SessionSearchValueRow } from './session-search-value-row'
import type SyncDatabase from '../sqlite/sync-database'
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
type Mutation = {
  source: number
  path: string
  parent: string
  fields: SessionSearchPhysicalFields
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
  private readonly pending = new Map<string, { table: SessionSearchPhysicalTable } & Mutation>()
  private readonly epochs = new Map<
    string,
    { source: number; revision: number; path?: string; cutoff?: number }
  >()
  private readonly sizes = new Map<string, number>()
  private readonly fallback = new Map<string, SessionSearchValueRow | undefined>()
  private readonly floors = new Map<number, SessionSearchInventoryFloor>()
  private bytes = 1024
  constructor(private readonly db: SyncDatabase) {}

  private retain(key: string, value: unknown): boolean {
    let retained = true
    // Pending patches reserve their parameter tuples and encoded SQL payload too.
    const copies = key.startsWith('write:') || key.startsWith('epoch:') ? 3 : 1
    const bytes = (JSON.stringify([key, value]).length * 2 + 64) * copies
    const previous = this.sizes.get(key) ?? 0
    if (
      this.sizes.size &&
      (this.sizes.size + Number(!previous) > 256 || this.bytes - previous + bytes > 256 * 1024)
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
    // Group only final independent column patches; masks preserve untouched versus NULL.
    while (this.pending.size) {
      const first = this.pending.values().next().value!
      const names = Object.keys(first.fields).sort()
      const signature = names.join(',')
      const rows: Mutation[] = []
      for (const [key, row] of this.pending) {
        if (row.table === first.table && Object.keys(row.fields).sort().join(',') === signature) {
          rows.push({ source: row.source, path: row.path, parent: row.parent, fields: row.fields })
          this.pending.delete(key)
        }
      }
      const payload = JSON.stringify(
        rows.map(({ source, path, parent, fields }) => [
          source,
          path,
          parent,
          ...names.map((name) => fields[name])
        ])
      )
      this.db
        .prepare(`INSERT INTO temp.${first.table} (source,path,parent,${signature})
        SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),${names.map((_, index) => `json_extract(value,'$[${index + 3}]')`).join(',')}
        FROM json_each(?) WHERE 1 ON CONFLICT(source,path) DO UPDATE SET ${names.map((name) => `${name}=excluded.${name}`).join(',')}`)
        .run(payload)
      if (
        rows.some((row) => Object.values(row.fields).some((value) => value === null || value === 0))
      ) {
        const empty =
          first.table === 'search_inventory_entries'
            ? 'file_revision IS NULL AND directory=0'
            : 'authority_self IS NULL AND observation_authority IS NULL AND delivery_revision IS NULL'
        this.db
          .prepare(`DELETE FROM temp.${first.table} WHERE (source,path) IN
          (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)) AND ${empty}`)
          .run(payload)
      }
    }
    this.flushEpochs()
    for (const [key, size] of this.sizes) {
      if (key.startsWith('write:')) {
        this.sizes.delete(key)
        this.bytes -= size
      }
    }
  }
  flushEpochs(): void {
    if (this.epochs.size) {
      const inserted: (string | number | undefined)[][] = [],
        removed: number[][] = []
      for (const row of this.epochs.values()) {
        if (row.path === undefined) {
          removed.push([row.source, row.revision])
        } else {
          inserted.push([row.source, row.revision, row.path, row.cutoff])
        }
      }
      if (removed.length) {
        this.db
          .prepare(`DELETE FROM temp.search_inventory_epochs
        WHERE kind='observation-epochs' AND (source,revision) IN
        (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`)
          .run(JSON.stringify(removed))
      }
      if (inserted.length) {
        this.db
          .prepare(`INSERT INTO temp.search_inventory_epochs(source,kind,revision,path,cutoff,sealed)
        SELECT json_extract(value,'$[0]'),'observation-epochs',json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),0
        FROM json_each(?) WHERE 1 ON CONFLICT(source,kind,revision) WHERE kind='observation-epochs'
        DO UPDATE SET path=excluded.path,cutoff=excluded.cutoff,sealed=0`)
          .run(JSON.stringify(inserted))
      }
      this.epochs.clear()
    }
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
    this.bytes = 1024
  }
}
