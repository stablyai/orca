import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult,
  SessionSearchCatalogRow
} from './session-search-catalog'
import {
  SESSION_SEARCH_CATALOG_PAGE_BYTES,
  SESSION_SEARCH_CATALOG_PAGE_ROWS
} from './session-search-catalog'

export type SessionSearchCatalogRequest = (
  command: SessionSearchCatalogCommand
) => Promise<SessionSearchCatalogResult>

/** Every call settles before another page is retained; records remain owned by the writer. */
export class SessionSearchCatalogClient<T> {
  constructor(
    readonly scope: string,
    private readonly request: SessionSearchCatalogRequest
  ) {}

  async get(key: string): Promise<T | undefined> {
    const row = (await this.request({ kind: 'get', scope: this.scope, key })).rows?.[0]
    return row ? this.decode(row) : undefined
  }

  async put(
    key: string,
    value: T,
    index: { parent?: string; group?: string; rank?: number; ready?: number } = {}
  ): Promise<void> {
    await this.request({
      kind: 'put',
      scope: this.scope,
      rows: [this.encode(key, value, index)]
    })
  }

  async putPage(rows: SessionSearchCatalogRow[]): Promise<void> {
    let batch: SessionSearchCatalogRow[] = []
    let bytes = 0
    for (const row of rows) {
      const size =
        (row.key.length + row.value.length + row.parent.length + row.group.length) * 2 + 64
      if (
        batch.length &&
        (batch.length === SESSION_SEARCH_CATALOG_PAGE_ROWS ||
          bytes + size > SESSION_SEARCH_CATALOG_PAGE_BYTES)
      ) {
        await this.request({ kind: 'put', scope: this.scope, rows: batch })
        batch = []
        bytes = 0
      }
      batch.push(row)
      bytes += size
    }
    if (batch.length) {
      await this.request({ kind: 'put', scope: this.scope, rows: batch })
    }
  }

  async delete(key: string): Promise<void> {
    await this.request({ kind: 'delete', scope: this.scope, key })
  }

  async releasePrefix(prefix: string): Promise<number> {
    return (await this.request({ kind: 'release-prefix', scope: this.scope, prefix })).count ?? 0
  }
  async release(): Promise<void> {
    await this.request({ kind: 'release', scope: this.scope })
  }

  async count(ready?: number): Promise<number> {
    return (await this.request({ kind: 'count', scope: this.scope, ready })).count ?? 0
  }

  async page(
    options: {
      after?: string
      parent?: string
      group?: string
      ready?: number
      orderRank?: boolean
      limit?: number
      prefix?: string
    } = {}
  ): Promise<{ rows: { key: string; value: T }[]; after?: string }> {
    const result = await this.request({ kind: 'page', scope: this.scope, ...options })
    return {
      rows: (result.rows ?? []).map((row) => ({ key: row.key, value: this.decode(row) })),
      after: result.after
    }
  }

  encode(
    key: string,
    value: T,
    index: { parent?: string; group?: string; rank?: number; ready?: number } = {}
  ): SessionSearchCatalogRow {
    return {
      key,
      value: JSON.stringify(value),
      parent: index.parent ?? '',
      group: index.group ?? '',
      rank: index.rank ?? 0,
      ready: index.ready ?? 0
    }
  }

  private decode(row: SessionSearchCatalogRow): T {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connection-private rows are encoded by this scope's typed owner.
    return JSON.parse(row.value) as T
  }
}
