import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult,
  SessionSearchCatalogRow
} from './session-search-catalog'
import { sessionSearchRecordPages } from './session-search-catalog-pages'
import {
  SESSION_SEARCH_CATALOG_PAGE_BYTES,
  SESSION_SEARCH_CATALOG_PAGE_ROWS
} from './session-search-catalog'

export type SessionSearchCatalogRequest = (
  command: SessionSearchCatalogCommand
) => Promise<SessionSearchCatalogResult>

const counts = new WeakMap<
  SessionSearchCatalogRequest,
  Map<string, { count: number; runnable: number }>
>()

export function recordSessionSearchCatalogCounts(
  send: SessionSearchCatalogRequest,
  result: SessionSearchCatalogResult
): void {
  if (!counts.has(send)) {
    counts.set(send, new Map())
  }
  for (const [scope, count, runnable] of result.scopeCounts ?? []) {
    if (count) {
      counts.get(send)!.set(scope, { count, runnable })
    } else {
      counts.get(send)!.delete(scope)
    }
  }
}

/** Every call settles before another page is retained; records remain owned by the writer. */
export class SessionSearchCatalogClient<T> {
  constructor(
    readonly scope: string,
    readonly send: SessionSearchCatalogRequest
  ) {
    if (!counts.has(send)) {
      counts.set(send, new Map())
    }
  }
  private async request(command: SessionSearchCatalogCommand): Promise<SessionSearchCatalogResult> {
    const result = await this.send(command)
    recordSessionSearchCatalogCounts(this.send, result)
    return result
  }
  get size(): number {
    return counts.get(this.send)?.get(this.scope)?.count ?? 0
  }
  get readySize(): number {
    return counts.get(this.send)?.get(this.scope)?.runnable ?? 0
  }
  transition(command: SessionSearchCatalogCommand): Promise<SessionSearchCatalogResult> {
    return this.request(command)
  }

  async getPage(keys: string[]): Promise<Map<string, T>> {
    const values = new Map<string, T>()
    for (const page of sessionSearchRecordPages(keys)) {
      let offset = 0
      while (offset < page.length) {
        const result = await this.request({
          kind: 'get-page',
          scope: this.scope,
          keys: page.slice(offset)
        })
        for (const row of result.rows ?? []) {
          values.set(row.key, this.decode(row))
        }
        if (!result.processed) {
          throw new Error('Session catalog projection did not advance')
        }
        offset += result.processed
      }
    }
    return values
  }
  async deletePage(keys: string[]): Promise<void> {
    for (const page of sessionSearchRecordPages(keys)) {
      await this.request({ kind: 'delete-page', scope: this.scope, keys: page })
    }
  }
  async get(key: string): Promise<T | undefined> {
    const row = (await this.request({ kind: 'get', scope: this.scope, key })).rows?.[0]
    return row ? this.decode(row) : undefined
  }

  async put(
    key: string,
    value: T,
    index: { parent?: string; group?: string; rank?: number; ready?: number; tie?: number } = {}
  ): Promise<void> {
    await this.request({
      kind: 'put',
      scope: this.scope,
      rows: [this.encode(key, value, index)]
    })
  }

  async putPage(
    rows: SessionSearchCatalogRow[],
    directory?: { scope: string; path: string; epoch: number }
  ): Promise<void> {
    let batch: SessionSearchCatalogRow[] = []
    const send = (page: SessionSearchCatalogRow[]) =>
      this.request(
        directory
          ? { kind: 'directory-stage', ...directory, rows: page }
          : { kind: 'put', scope: this.scope, rows: page }
      )
    const overhead = 1024 + JSON.stringify([this.scope, directory]).length * 2
    let bytes = overhead
    for (const row of rows) {
      const size = JSON.stringify(row).length * 2 + 64
      if (
        batch.length &&
        (batch.length === SESSION_SEARCH_CATALOG_PAGE_ROWS ||
          bytes + size > SESSION_SEARCH_CATALOG_PAGE_BYTES)
      ) {
        await send(batch)
        batch = []
        bytes = overhead
      }
      batch.push(row)
      bytes += size
    }
    if (batch.length) {
      await send(batch)
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
      orderRevision?: boolean
      limit?: number
      prefix?: string
      throughRevision?: number
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
    index: { parent?: string; group?: string; rank?: number; ready?: number; tie?: number } = {}
  ): SessionSearchCatalogRow {
    return {
      key,
      value: JSON.stringify(value),
      parent: index.parent ?? '',
      group: index.group ?? '',
      rank: index.rank ?? 0,
      ready: index.ready ?? 0,
      tie: index.tie ?? 0
    }
  }

  decode(row: SessionSearchCatalogRow): T {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connection-private rows are encoded by this scope's typed owner.
    return JSON.parse(row.value) as T
  }
}
