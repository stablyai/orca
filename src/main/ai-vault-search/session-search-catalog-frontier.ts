import { sessionSearchRecordPages } from './session-search-catalog-pages'
import {
  SessionSearchCatalogClient,
  recordSessionSearchCatalogCounts
} from './session-search-catalog-client'

type Entry<T> = { value: T; order: number; revision: number }

/** Only the active head is projected; queued directory and cleanup work stays on disk. */
export class SessionSearchCatalogFrontier<T> {
  constructor(private readonly catalog: SessionSearchCatalogClient<Entry<T>>) {}

  get waking(): boolean {
    return this.wakes.size > 0
  }
  private get wakes() {
    return new SessionSearchCatalogClient<unknown>(`${this.catalog.scope}:wake`, this.catalog.send)
  }
  async wake(): Promise<void> {
    await this.catalog.transition({ kind: 'frontier-wake', scope: this.catalog.scope })
  }

  get size(): number {
    return this.catalog.size
  }

  async refresh(): Promise<void> {
    await this.catalog.count()
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.catalog.get(key))?.value
  }

  async has(key: string): Promise<boolean> {
    return (await this.catalog.get(key)) !== undefined
  }

  async set(key: string, value: T): Promise<void> {
    await this.catalog.transition({
      kind: 'frontier-set',
      scope: this.catalog.scope,
      key,
      value: JSON.stringify(value)
    })
  }

  async setPage(values: readonly (readonly [string, T])[]): Promise<void> {
    for (const rows of sessionSearchRecordPages(
      values.map(([key, value]) => ({ key, value: JSON.stringify(value) }))
    )) {
      await this.catalog.transition({ kind: 'frontier-set-page', scope: this.catalog.scope, rows })
    }
  }
  async movePageTo(target: SessionSearchCatalogFrontier<T>): Promise<void> {
    const result = await this.catalog.transition({
      kind: 'frontier-move',
      scope: this.catalog.scope,
      target: target.catalog.scope
    })
    recordSessionSearchCatalogCounts(target.catalog.send, result)
  }
  async snapshot(): Promise<number> {
    const result = await this.catalog.transition({
      kind: 'frontier-snapshot',
      scope: this.catalog.scope
    })
    if (result.revision === undefined) {
      throw new Error('Session frontier snapshot was not accepted')
    }
    return result.revision
  }
  async settlePaths(
    target: SessionSearchCatalogFrontier<string>,
    cutoff: number,
    rows: { key: string; revision?: number; outcome?: 'retry' | 'parked' }[]
  ): Promise<void> {
    const result = await this.catalog.transition({
      kind: 'frontier-settle',
      scope: this.catalog.scope,
      target: target.catalog.scope,
      cutoff,
      rows
    })
    recordSessionSearchCatalogCounts(target.catalog.send, result)
  }
  async receipts(limit = 256, cutoff?: number) {
    const page = await this.catalog.page({
      group: '',
      orderRevision: true,
      limit,
      throughRevision: cutoff
    })
    return page.rows.map(({ key, value }) => ({
      key,
      value: value.value,
      revision: value.revision
    }))
  }
  async acknowledge(receipts: { key: string; revision: number }[]): Promise<void> {
    await this.catalog.transition({ kind: 'frontier-ack', scope: this.catalog.scope, receipts })
  }
  async firstPage(limit = 256): Promise<readonly (readonly [string, T])[]> {
    const page = await this.catalog.page({ group: '', orderRank: true, limit })
    return page.rows.map(({ key, value }) => [key, value.value] as const)
  }
  async deletePage(keys: string[]): Promise<void> {
    await this.catalog.transition({ kind: 'delete-page', scope: this.catalog.scope, keys })
  }
  async delete(key: string): Promise<void> {
    await this.catalog.delete(key)
  }

  async cancelTree(path: string): Promise<void> {
    await this.catalog.releasePrefix(path)
  }

  async firstEntry(): Promise<readonly [string, T] | undefined> {
    const page = await this.catalog.page({ group: '', orderRank: true, limit: 1 })
    const entry = page.rows[0]
    return entry ? [entry.key, entry.value.value] : undefined
  }
}
