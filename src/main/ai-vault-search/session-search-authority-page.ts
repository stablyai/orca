import { dirname } from 'node:path'
import { isInsideSessionRoot } from '../ai-vault/discovery/session-file-discovery'
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
  file(path: string): SessionSearchObservedFacts | undefined {
    return this.physical.file(path)
  }
  putFile(path: string, value?: SessionSearchObservedFacts): void {
    this.physical.putFile(path, value)
  }
  observing(path: string): string | undefined {
    return this.physical.observing(path)
  }
  putObserving(path: string, value?: string): void {
    this.physical.putObserving(path, value)
  }
  delivery(path: string): SessionSearchObservedDelivery | undefined {
    return this.physical.delivery(path)
  }
  putDelivery(path: string, value?: SessionSearchObservedDelivery): void {
    this.physical.putDelivery(path, value)
  }
  epoch(revision: number, path?: string): void {
    this.physical.epoch(revision, path)
  }
  private putAuthority(path: string, value?: Authority): void {
    this.physical.putAuthority(path, value && { ...value, ready: value.ready ?? 1 })
  }
  *ancestry(path: string): Generator<string> {
    const base = this.physical.root
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
    return this.physical.authority(path)
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
      this.physical.ensureDirectory(key)
    }
  }
  settle(path: string): void {
    const value = this.authority(path)
    if (!value) {
      return
    }
    const suffixes = ['dirty', 'refusals', 'file-refusals']
    let claimed =
      this.physical.claimed(path) ||
      suffixes.some(
        (suffix) => !!this.catalog.inventory.peekFallback(`${this.scope}:${suffix}`, path)
      )
    if (!claimed && value.tree <= this.catalog.minimumFloor(this.scope)) {
      claimed =
        !!this.observing(path) ||
        !!this.delivery(path) ||
        suffixes.some((suffix) => !!this.get(`${this.scope}:${suffix}`, path))
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
