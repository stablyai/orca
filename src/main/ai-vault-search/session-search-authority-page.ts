import { dirname } from 'node:path'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'
import type { SessionSearchValueRow } from './session-search-value-row'
import type { SessionSearchObservedFacts } from './session-search-observation-types'
import type { SessionSearchObservedDelivery } from './session-search-inventory-observation'
export function authorityValue<T>(
  row: SessionSearchCatalogRow | SessionSearchValueRow | undefined
): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these connection-private records have one typed writer.
  return row ? (('data' in row ? row.data : JSON.parse(row.value)) as T) : undefined
}

type Authority = { self: number; tree: number; ready?: number }

/** Facts are shared only within one synchronous inventory transition. */
export class SessionSearchAuthorityPage {
  private readonly physical: ReturnType<SessionSearchCatalog['inventoryObservation']>
  private base: string | undefined
  private baseRead = false
  constructor(
    private readonly catalog: SessionSearchCatalog,
    readonly scope: string
  ) {
    this.physical = catalog.inventoryObservation(scope)
  }
  get(scope: string, path: string): SessionSearchValueRow | undefined {
    return this.catalog.inventory.fallbackValue(scope, path, () =>
      this.catalog.valueRow(scope, path)
    )
  }
  forget(scope: string, path: string): void {
    this.catalog.inventory.forgetFallback(scope, path)
  }
  private put(suffix: string, path: string, data: unknown, ready = 0, rank = 0, group = ''): void {
    this.catalog.putValue(`${this.scope}:${suffix}`, {
      key: path,
      data,
      parent: suffix === 'authority' ? '' : dirname(path),
      group,
      rank,
      ready
    })
    this.forget(`${this.scope}:${suffix}`, path)
  }
  private remove(suffix: string, path: string): void {
    this.catalog.execute({ kind: 'delete', scope: `${this.scope}:${suffix}`, key: path })
    this.forget(`${this.scope}:${suffix}`, path)
  }
  file(path: string): SessionSearchObservedFacts | undefined {
    return this.physical
      ? this.physical.file(path)
      : authorityValue(this.get(`${this.scope}:files`, path))
  }
  putFile(path: string, value?: SessionSearchObservedFacts): void {
    if (this.physical) {
      this.physical.putFile(path, value)
    } else if (value) {
      this.put('files', path, value, 0, 0, value.dependency ?? '')
    } else {
      this.remove('files', path)
    }
  }
  observing(path: string): string | undefined {
    return this.physical
      ? this.physical.observing(path)
      : authorityValue(this.get(`${this.scope}:observing`, path))
  }
  putObserving(path: string, value?: string): void {
    if (this.physical) {
      this.physical.putObserving(path, value)
    } else if (value !== undefined) {
      this.put('observing', path, value)
    } else {
      this.remove('observing', path)
    }
  }
  delivery(path: string): SessionSearchObservedDelivery | undefined {
    return this.physical
      ? this.physical.delivery(path)
      : authorityValue(this.get(`${this.scope}:delivery`, path))
  }
  putDelivery(path: string, value?: SessionSearchObservedDelivery): void {
    if (this.physical) {
      this.physical.putDelivery(path, value)
    } else if (value) {
      this.put('delivery', path, value)
    } else {
      this.remove('delivery', path)
    }
  }
  epoch(revision: number, path?: string): void {
    if (this.physical) {
      this.physical.epoch(revision, path)
    } else if (path !== undefined) {
      this.catalog.putValue(`${this.scope}:observation-epochs`, {
        key: String(revision),
        data: path,
        parent: '',
        group: '',
        rank: revision,
        ready: 0
      })
    } else {
      this.remove('observation-epochs', String(revision))
    }
  }
  private putAuthority(path: string, value?: Authority): void {
    if (this.physical) {
      this.physical.putAuthority(path, value && { ...value, ready: value.ready ?? 1 })
    } else if (value) {
      this.put(
        'authority',
        path,
        { self: value.self, tree: value.tree },
        value.ready ?? 1,
        value.tree
      )
    } else {
      this.remove('authority', path)
    }
  }
  private root(): string | undefined {
    if (!this.baseRead) {
      this.base =
        this.physical?.root ??
        authorityValue<string>(this.get(`${this.scope}:authority-root`, 'root'))
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
    if (this.physical) {
      return this.physical.authority(path)
    }
    const row = this.get(`${this.scope}:authority`, path)
    const value = authorityValue<Authority>(row)
    return value && { ...value, ready: row?.ready }
  }
  record(path: string, revision: number, ready = 1): void {
    for (const key of this.ancestry(path)) {
      const old = this.authority(key)
      this.putAuthority(key, {
        self: key === path ? revision : (old?.self ?? 0),
        tree: Math.max(revision, old?.tree ?? 0),
        ready: key === path ? ready : (old?.ready ?? 1)
      })
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
      if (key === path) {
        continue
      }
      if (this.physical) {
        this.physical.ensureDirectory(key)
      } else if (!this.get(`${this.scope}:directories`, key)) {
        this.put('directories', key, true)
      }
    }
  }
  settle(path: string): void {
    const value = this.authority(path)
    if (!value) {
      return
    }
    const suffixes = ['dirty', 'refusals', 'file-refusals', 'observing', 'delivery']
    let claimed =
      !!this.physical?.claimed(path) ||
      suffixes.some(
        (suffix) => !!this.catalog.inventory.peekFallback(`${this.scope}:${suffix}`, path)
      )
    if (!claimed && value.tree <= this.catalog.minimumFloor(this.scope)) {
      claimed =
        !!this.observing(path) ||
        !!this.delivery(path) ||
        suffixes.slice(0, 3).some((suffix) => !!this.get(`${this.scope}:${suffix}`, path))
      if (!claimed) {
        this.putAuthority(path)
        return
      }
    }
    if (value.ready !== Number(!claimed)) {
      this.putAuthority(path, { ...value, ready: Number(!claimed) })
    }
  }
  flush(): void {
    this.catalog.inventory.flush()
  }
}
