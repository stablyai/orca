import type { SessionSearchCatalogClient } from './session-search-catalog-client'

type Entry<T> = { value: T; order: number }

/** Only the active head is projected; queued directory and cleanup work stays on disk. */
export class SessionSearchCatalogFrontier<T> {
  private count = 0
  private sequence = 0
  constructor(private readonly catalog: SessionSearchCatalogClient<Entry<T>>) {}

  get size(): number {
    return this.count
  }

  async get(key: string): Promise<T | undefined> {
    return (await this.catalog.get(key))?.value
  }

  async has(key: string): Promise<boolean> {
    return (await this.catalog.get(key)) !== undefined
  }

  async set(key: string, value: T): Promise<void> {
    const existing = await this.catalog.get(key)
    const order = existing?.order ?? ++this.sequence
    await this.catalog.put(key, { value, order }, { rank: order })
    if (!existing) {
      this.count++
    }
  }

  async delete(key: string): Promise<void> {
    if (await this.has(key)) {
      await this.catalog.delete(key)
      this.count--
    }
  }

  async cancelTree(path: string): Promise<void> {
    this.count -= await this.catalog.releasePrefix(path)
  }

  async firstEntry(): Promise<readonly [string, T] | undefined> {
    const page = await this.catalog.page({ group: '', orderRank: true, limit: 1 })
    const entry = page.rows[0]
    return entry ? [entry.key, entry.value.value] : undefined
  }
}
