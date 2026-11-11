import { dirname } from 'node:path'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchValueRow } from './session-search-value-row'
import {
  decodeSessionSearchInventoryValue,
  sessionSearchInventoryColumns,
  type SessionSearchInventoryMember
} from './session-search-inventory-relation'

const physicalMembers = {
  search_inventory_entries: ['files', 'directories'],
  search_inventory_activity: ['authority', 'observing', 'delivery']
} satisfies Record<string, SessionSearchInventoryMember[]>
type PhysicalTable = keyof typeof physicalMembers

/** Discarded at the synchronous acceptance boundary, including rollback. */
export class SessionSearchInventoryPage {
  readonly sources = new Map<string, number | undefined>()
  readonly rows = new Map<string, SessionSearchValueRow | undefined>()
  private readonly physical = new Map<string, Record<string, unknown>>()
  private readonly activity = new Map<
    string,
    { source: number; path: string; fields: Record<string, SyncDatabase.BindValue> }
  >()
  constructor(private readonly db: SyncDatabase) {}

  readValue(
    source: number,
    member: SessionSearchInventoryMember,
    path: string,
    table: PhysicalTable
  ) {
    const key = `${table}:${source}:${path}`
    let row = this.physical.get(key)
    if (!row) {
      const columns = [
        ...new Set([
          ...physicalMembers[table].flatMap((part) =>
            sessionSearchInventoryColumns(part).split(',')
          ),
          ...(table === 'search_inventory_activity' ? ['reclaimable'] : [])
        ])
      ]
      row = this.db
        .prepare(`SELECT parent,${columns.join(',')} FROM temp.${table} WHERE source=? AND path=?`)
        .get(source, path) ?? { path, parent: dirname(path) }
      if (table === 'search_inventory_activity') {
        Object.assign(row, this.activity.get(`${source}:${path}`)?.fields)
      }
      this.physical.set(key, row)
    }
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

  patch(
    table: string,
    source: number,
    path: string,
    fields: Record<string, SyncDatabase.BindValue>
  ): void {
    if (table !== 'search_inventory_entries' && table !== 'search_inventory_activity') {
      return
    }
    const key = `${table}:${source}:${path}`
    const row = this.physical.get(key)
    if (row) {
      Object.assign(row, fields)
    }
    for (const member of physicalMembers[table]) {
      this.rows.delete(`${source}:${member}:${path}`)
    }
  }

  writeActivity(
    source: number,
    path: string,
    fields: Record<string, SyncDatabase.BindValue>
  ): void {
    const key = `${source}:${path}`
    const previous = this.activity.get(key)
    this.activity.set(key, { source, path, fields: { ...previous?.fields, ...fields } })
    this.patch('search_inventory_activity', source, path, fields)
  }
  flush(): void {
    for (const { source, path, fields } of this.activity.values()) {
      const names = Object.keys(fields).sort()
      this.db
        .prepare(`INSERT INTO temp.search_inventory_activity
        (source,path,parent,${names.join(',')}) VALUES (?,?,?,${names.map(() => '?').join(',')})
        ON CONFLICT(source,path) DO UPDATE SET ${names.map((name) => `${name}=excluded.${name}`).join(',')}`)
        .run(source, path, dirname(path), ...names.map((name) => fields[name]))
      if (Object.values(fields).some((value) => value === null)) {
        this.db
          .prepare(`DELETE FROM temp.search_inventory_activity WHERE source=? AND path=?
          AND authority_self IS NULL AND observation_authority IS NULL AND delivery_revision IS NULL`)
          .run(source, path)
      }
    }
    this.activity.clear()
  }
  clear(): void {
    this.sources.clear()
    this.rows.clear()
    this.physical.clear()
  }
}
