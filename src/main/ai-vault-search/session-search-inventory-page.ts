import { dirname } from 'node:path'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchValueRow } from './session-search-value-row'

/** Discarded at the synchronous acceptance boundary, including rollback. */
export class SessionSearchInventoryPage {
  readonly sources = new Map<string, number | undefined>()
  readonly rows = new Map<string, SessionSearchValueRow | undefined>()
  private readonly activity = new Map<
    string,
    { source: number; path: string; fields: Record<string, SyncDatabase.BindValue> }
  >()
  constructor(private readonly db: SyncDatabase) {}

  writeActivity(
    source: number,
    path: string,
    fields: Record<string, SyncDatabase.BindValue>
  ): void {
    const key = `${source}:${path}`
    const previous = this.activity.get(key)
    this.activity.set(key, { source, path, fields: { ...previous?.fields, ...fields } })
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
  }
}
