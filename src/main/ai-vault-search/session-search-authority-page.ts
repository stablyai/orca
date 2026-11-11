import { dirname } from 'node:path'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'
import { authorityValue } from './session-search-observation-authority'

type Authority = { self: number; tree: number }

/** Facts are shared only within one synchronous inventory transition. */
export class SessionSearchAuthorityPage {
  private readonly rows = new Map<string, SessionSearchCatalogRow | undefined>()
  private readonly writes = new Map<string, SessionSearchCatalogRow>()
  private base: string | undefined
  private baseRead = false
  private floor: number | undefined
  constructor(
    private readonly catalog: SessionSearchCatalog,
    readonly scope: string
  ) {}

  get(scope: string, path: string): SessionSearchCatalogRow | undefined {
    const key = `${scope}\0${path}`
    if (!this.rows.has(key)) {
      this.rows.set(key, this.catalog.execute({ kind: 'get', scope, key: path }).rows?.[0])
    }
    return this.rows.get(key)
  }
  forget(scope: string, path: string): void {
    this.rows.delete(`${scope}\0${path}`)
  }
  changed(scope: string, path: string, row?: SessionSearchCatalogRow): void {
    this.rows.set(`${scope}\0${path}`, row)
  }
  private root(): string | undefined {
    if (!this.baseRead) {
      this.base = authorityValue<string>(this.get(`${this.scope}:authority-root`, 'root'))
      this.baseRead = true
    }
    return this.base
  }
  *ancestry(path: string): Generator<string> {
    const base = this.root()
    let key = path
    do {
      yield key
      if (!base || key === base || dirname(key) === key) {
        return
      }
      key = dirname(key)
    } while (isInsideSessionRoot(base, key))
  }
  authority(path: string): Authority | undefined {
    return authorityValue<Authority>(this.get(`${this.scope}:authority`, path))
  }
  record(path: string, revision: number, ready = 1): void {
    for (const key of this.ancestry(path)) {
      const oldRow = this.get(`${this.scope}:authority`, key)
      const old = authorityValue<Authority>(oldRow)
      const tree = Math.max(revision, old?.tree ?? 0)
      const row = {
        key,
        value: JSON.stringify({ self: key === path ? revision : (old?.self ?? 0), tree }),
        parent: '',
        group: '',
        rank: tree,
        ready: key === path ? ready : (oldRow?.ready ?? 1)
      }
      this.writes.set(key, row)
      this.changed(`${this.scope}:authority`, key, row)
    }
  }
  newer(path: string, cutoff: number): boolean {
    for (const key of this.ancestry(path)) {
      const value = this.authority(key)
      if ((key === path ? (value?.tree ?? 0) : (value?.self ?? 0)) > cutoff) {
        return true
      }
    }
    return false
  }
  ensureDirectories(path: string): void {
    for (const key of this.ancestry(path)) {
      if (key === path || this.get(`${this.scope}:directories`, key)) {
        continue
      }
      const row = { key, value: 'true', parent: dirname(key), group: '', rank: 0, ready: 0 }
      this.catalog.execute({ kind: 'put', scope: `${this.scope}:directories`, rows: [row] })
      this.changed(`${this.scope}:directories`, key, row)
    }
  }
  settle(path: string): void {
    const row = this.get(`${this.scope}:authority`, path)
    if (!row) {
      return
    }
    const scopes = ['dirty', 'observing', 'refusals', 'file-refusals', 'delivery'].map(
      (suffix) => `${this.scope}:${suffix}`
    )
    let live = scopes.some((scope) => !!this.rows.get(`${scope}\0${path}`))
    if (!live) {
      this.floor ??= Math.min(
        ...['epochs', 'observation-epochs', 'removal-epochs'].map(
          (suffix) =>
            this.catalog.execute({
              kind: 'page',
              scope: `${this.scope}:${suffix}`,
              group: '',
              orderRank: true,
              limit: 1
            }).rows?.[0]?.rank ?? Infinity
        )
      )
      // A protected witness gets one liveness check when its epoch permits cleanup.
      if (row.rank <= this.floor) {
        live = scopes.some((scope) => !!this.get(scope, path))
        if (!live) {
          this.catalog.execute({ kind: 'delete', scope: `${this.scope}:authority`, key: path })
          this.writes.delete(path)
          this.changed(`${this.scope}:authority`, path)
          return
        }
      }
    }
    if (row.ready !== Number(!live)) {
      const next = { ...row, ready: Number(!live) }
      this.writes.set(path, next)
      this.changed(`${this.scope}:authority`, path, next)
    }
  }
  flush(): void {
    for (const row of this.writes.values()) {
      this.catalog.execute({ kind: 'put', scope: `${this.scope}:authority`, rows: [row] })
    }
    this.writes.clear()
  }
}
