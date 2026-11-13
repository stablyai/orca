import type {
  CommunityCatalog,
  CommunityPullRequest,
  CommunitySyncStatus
} from '../../shared/community-catalog'
import type { CommunityCatalogStore } from './community-catalog-store'
import { refreshCommunityCatalog } from './community-catalog-refresh'
import type { CommunityGitHubSource } from './community-github-source'
import { CommunityGitHubError } from './community-github-source'

export class CommunityService {
  private initialized: Promise<CommunityCatalog | null> | null = null
  private refreshing: Promise<void> | null = null
  private controller: AbortController | null = null
  private details = new Map<number, Promise<CommunityPullRequest>>()
  private writes: Promise<void> = Promise.resolve()
  private status: CommunitySyncStatus = {
    running: false,
    pages: 0,
    received: 0,
    error: null,
    retryAt: null
  }

  constructor(
    private readonly store: CommunityCatalogStore,
    private readonly source: Pick<CommunityGitHubSource, 'page' | 'detail'>,
    private readonly publish: (status: CommunitySyncStatus) => void
  ) {}

  private initialize(): Promise<CommunityCatalog | null> {
    return (this.initialized ??= this.store.load())
  }

  private update(patch: Partial<CommunitySyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.publish(this.status)
  }

  async read(): Promise<{ catalog: CommunityCatalog | null; status: CommunitySyncStatus }> {
    await this.initialize()
    return { catalog: this.store.current(), status: this.status }
  }

  async refresh(): Promise<{ catalog: CommunityCatalog | null; status: CommunitySyncStatus }> {
    await this.initialize()
    if (!this.refreshing) {
      if (this.status.retryAt && Date.parse(this.status.retryAt) > Date.now()) {
        return this.read()
      }
      this.refreshing = this.performRefresh().finally(() => {
        this.refreshing = null
      })
    }
    await this.refreshing
    return this.read()
  }

  private async performRefresh(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const startedAt = new Date().toISOString()
    this.update({ running: true, pages: 0, received: 0, error: null, retryAt: null })
    try {
      const previous = this.store.current()
      const previousRows = new Map(previous?.pullRequests.map((pr) => [pr.number, pr]))
      const observations = new Map<number, CommunityPullRequest>()
      let catalog = await refreshCommunityCatalog({
        previous,
        startedAt,
        signal: controller.signal,
        progress: (pages, received) => this.update({ pages, received }),
        page: async (page, mode) => {
          const rows = await this.source.page(page, mode, controller.signal, previousRows)
          rows.forEach((row) => observations.set(row.number, row))
          return rows
        }
      })
      await this.commit(async () => {
        controller.signal.throwIfAborted()
        // A detail read completed after refresh started must keep its newer observation.
        for (const row of this.store.current()?.pullRequests ?? []) {
          if (row.observedAt && row.observedAt > startedAt) {
            observations.set(row.number, row)
          }
        }
        const rows = new Map(catalog.pullRequests.map((pr) => [pr.number, pr]))
        for (const row of observations.values()) {
          if (row.state === 'closed' || row.state === 'merged') {
            rows.delete(row.number)
          } else {
            rows.set(row.number, row)
          }
        }
        for (const { number, record } of this.store.newerRecords(startedAt)) {
          if (record.state !== 'open') {
            rows.delete(number)
            observations.delete(number)
          }
        }
        catalog = { ...catalog, pullRequests: [...rows.values()] }
        await this.store.save(catalog, [...observations.values()])
      })
      this.update({ error: null })
    } catch (error) {
      this.update({
        error: controller.signal.aborted
          ? 'Refresh cancelled.'
          : error instanceof Error
            ? error.message
            : 'GitHub refresh failed. The saved catalog is still available.',
        retryAt: error instanceof CommunityGitHubError ? error.retryAt : null
      })
    } finally {
      this.controller = null
      this.update({ running: false })
    }
  }

  cancel(): void {
    this.controller?.abort()
  }

  private commit(operation: () => Promise<void>): Promise<void> {
    const write = this.writes.then(operation)
    this.writes = write.catch(() => {})
    return write
  }

  async detail(number: number, force = false): Promise<CommunityPullRequest> {
    await this.initialize()
    const cached = this.store.current()?.pullRequests.find((pr) => pr.number === number)
    if (
      !force &&
      cached?.observedAt &&
      cached.changedFiles !== null &&
      Date.now() - Date.parse(cached.observedAt) < 120_000
    ) {
      return cached
    }
    const pending = this.details.get(number)
    if (pending) {
      return pending
    }
    if (this.status.retryAt && Date.parse(this.status.retryAt) > Date.now()) {
      throw new Error('GitHub is rate limited. Try again after the displayed retry time.')
    }
    const request = this.readDetail(number).finally(() => this.details.delete(number))
    this.details.set(number, request)
    return request
  }

  private async readDetail(number: number): Promise<CommunityPullRequest> {
    const startedAt = new Date().toISOString()
    const previous = this.store.current()?.pullRequests.find((pr) => pr.number === number)
    let row: CommunityPullRequest
    try {
      row = await this.source.detail(number, new AbortController().signal, previous)
    } catch (error) {
      if (error instanceof CommunityGitHubError) {
        this.update({ error: error.message, retryAt: error.retryAt })
      }
      throw error
    }
    let accepted = row
    await this.commit(async () => {
      const catalog = this.store.current()
      if (!catalog) {
        return
      }
      const current = catalog.pullRequests.find((pr) => pr.number === number)
      if (
        current?.observedAt &&
        current.observedAt > startedAt &&
        current.headSha !== row.headSha
      ) {
        accepted = current
        return
      }
      if (
        this.store
          .newerRecords(startedAt)
          .some((entry) => entry.number === number && entry.record.state !== 'open')
      ) {
        throw new Error(
          'This PR changed during the request. Reopen it to load the current version.'
        )
      }
      const rows = catalog.pullRequests.filter((pr) => pr.number !== number)
      if (row.state === 'open') {
        rows.push(row)
      }
      await this.store.save({ ...catalog, pullRequests: rows }, [row])
    })
    this.update({})
    return accepted
  }

  async captured(number: number): Promise<CommunityPullRequest | null> {
    await this.initialize()
    return this.store.captured(number)
  }

  async history(number: number) {
    await this.initialize()
    return this.store.recent(number)
  }
}
