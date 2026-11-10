import type { SessionSearchCatalogClient } from './session-search-catalog-client'

type Entry<T> = { value: T; order: number }

/** Only the active head is projected; queued directory and cleanup work stays on disk. */
export class SessionSearchCatalogFrontier<T> {
  constructor(private readonly catalog: SessionSearchCatalogClient<Entry<T>>) {}

  get size(): number {
    return this.catalog.size
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
