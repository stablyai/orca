import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { AgentTokenUsageReporter } from './agent-token-usage-reporter'
import type { AgentTokenSession } from './agent-token-usage'
import type { AgentTokenUsage } from '../../shared/telemetry-agent-token-usage-schema'
import { isTelemetryEnabled } from '../telemetry/client'
import { join, parse } from 'node:path'
import { AnalyticsSessionIdStore, type AnalyticsSessionId } from './analytics-session-id-store'
import type { Store } from '../persistence'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import { loadKnownUsageWorktreesByRepo } from '../usage-worktree-metadata'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import { createWorktreeRefs, getUsageWorktreeFingerprint } from './usage-worktree-refs'
import { UsageInlineCachePreservation } from './usage-inline-cache-preservation'
import {
  usageSourceCachePath,
  type UsageCacheSplitRequest,
  type UsageCacheSplitResult,
  type UsageSourceCacheRef
} from './usage-source-cache-file'

const STALE_MS = 5 * 60_000
// Keep large cache parsing on the worker; small reports retain synchronous reads.
const MAIN_THREAD_PARSE_MAX_BYTES = 8 * 1024 * 1024

type UsageProviderScanState = {
  enabled: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
}

type UsageProviderStoreState<SourceKey extends string> = {
  schemaVersion: number
  worktreeFingerprint: string | null
  sessions: unknown[]
  dailyAggregates: unknown[]
  scanState: UsageProviderScanState
} & Record<SourceKey, unknown[]>

type UsageProviderStoreLifecycleConfig<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> = {
  logTag: string
  resolveCacheFile: () => string
  createDefaultState: () => State
  normalizeState: (state: State) => State
  parseReport?: (
    text: string,
    parsed?: State,
    integrityVerified?: boolean
  ) => State | Promise<State>
  serializeReport?: (state: State) => string
  providerId?: 'claude'
  sourceKey: SourceKey
  dataPresenceKey: DataPresenceKey
  tokenUsage?: {
    provider: AgentTokenUsage['provider']
    selectSessions: (state: State) => AgentTokenSession[]
  }
  scan: (
    worktrees: UsageScanWorktreeRef[],
    sourceCache: UsageSourceCacheRef
  ) => Promise<Pick<State, 'sessions' | 'dailyAggregates'>>
  splitCacheFile: (request: UsageCacheSplitRequest) => Promise<UsageCacheSplitResult>
}

type PublicUsageProviderScanState<DataPresenceKey extends string> = UsageProviderScanState & {
  isScanning: boolean
} & Record<DataPresenceKey, boolean>

export abstract class UsageProviderStoreLifecycle<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> {
  // Per-source records belong to the worker and are excluded from report state.
  protected state: State
  private readonly loaded: Promise<void>
  private readonly schemaVersion: number
  private scanPromise: Promise<void> | null = null
  private tokenReporter: AgentTokenUsageReporter | null = null
  private analyticsSessionIds: AnalyticsSessionIdStore | null = null
  private readonly writer: UsageCacheSnapshotWriter
  private readonly inlineCache = new UsageInlineCachePreservation()

  constructor(
    private readonly store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
    private readonly config: UsageProviderStoreLifecycleConfig<SourceKey, State, DataPresenceKey>
  ) {
    this.writer = new UsageCacheSnapshotWriter(config.logTag, config.resolveCacheFile)
    const defaults = config.createDefaultState()
    this.schemaVersion = defaults.schemaVersion
    this.state = defaults
    this.loaded = this.load()
  }

  /** Resolves once persisted state is in memory; synchronous readers must wait for it first. */
  whenLoaded(): Promise<void> {
    return this.loaded
  }

  getScanState(): PublicUsageProviderScanState<DataPresenceKey> {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      [this.config.dataPresenceKey]:
        this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    } as PublicUsageProviderScanState<DataPresenceKey>
  }

  /** Local identity only; callers must use the usage store on the execution host. */
  getAnalyticsSessionIds(providerSessionIds: readonly string[]): Promise<AnalyticsSessionId[]> {
    if (!this.analyticsSessionIds) {
      const { dir, name } = parse(this.config.resolveCacheFile())
      this.analyticsSessionIds = new AnalyticsSessionIdStore(
        join(dir, `${name}-analytics-session-ids.json`)
      )
    }
    return this.analyticsSessionIds.getOrCreate(providerSessionIds)
  }

  /** Await queued cache writes so quit does not drop the final snapshot. */
  async flush(): Promise<void> {
    await this.loaded
    await this.inlineCache.settle()
    await this.tokenReporter?.flush()
    await Promise.all([this.writer.flush(), this.analyticsSessionIds?.flush()])
  }

  async setEnabled(enabled: boolean): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
    await this.loaded
    this.state.scanState.enabled = enabled
    await this.writeToDisk()
    return this.getScanState()
  }

  async refresh(force = false): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
    await this.loaded
    if (!this.state.scanState.enabled) {
      return this.getScanState()
    }
    const currentWorktreeFingerprint = await this.getCurrentWorktreeFingerprint()
    if (!force && this.state.scanState.lastScanCompletedAt) {
      const ageMs = Date.now() - this.state.scanState.lastScanCompletedAt
      if (ageMs < STALE_MS && this.state.worktreeFingerprint === currentWorktreeFingerprint) {
        return this.getScanState()
      }
    }
    await this.runScan()
    return this.getScanState()
  }

  protected writeToDisk(): Promise<void> {
    return this.inlineCache.write(
      this.config.resolveCacheFile(),
      () => this.state.scanState.enabled,
      this.writer,
      () => this.serializeReport()
    )
  }

  private serializeReport(): string {
    if (this.config.serializeReport) {
      return this.config.serializeReport(this.state)
    }
    const { [this.config.sourceKey]: _sources, ...report } = this.state
    return JSON.stringify(report)
  }

  private applyReport(text: string, parsed?: State, verified = false): void | Promise<void> {
    const report = this.config.parseReport
      ? this.config.parseReport(text, parsed, verified)
      : (parsed ?? JSON.parse(text))
    if (report instanceof Promise) {
      return report.then((state) => {
        this.state = this.normalizeReport(state)
      })
    }
    this.state = this.normalizeReport(report)
  }

  private load(): Promise<void> {
    const cacheFile = this.config.resolveCacheFile()
    try {
      if (statSync(cacheFile).size > MAIN_THREAD_PARSE_MAX_BYTES) {
        return this.loadOnWorker(cacheFile)
      }
      const text = readFileSync(cacheFile, 'utf-8')
      const parsed: State = JSON.parse(text)
      if (
        Array.isArray(parsed[this.config.sourceKey]) &&
        parsed[this.config.sourceKey].length > 0
      ) {
        return this.loadOnWorker(cacheFile)
      }
      const applied = this.applyReport(text, parsed)
      if (applied) {
        return applied.catch((error: unknown) => {
          console.error(`${this.config.logTag} Failed to load persisted state:`, error)
        })
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.error(`${this.config.logTag} Failed to load persisted state:`, error)
      }
    }
    return Promise.resolve()
  }

  private async loadOnWorker(cacheFile: string): Promise<void> {
    try {
      let fallback = false
      const { reportText, migrated, reportIntegrityVerified } = await Promise.resolve()
        .then(() =>
          this.config.splitCacheFile({
            cacheFile,
            sourceKey: this.config.sourceKey,
            ...(this.config.providerId ? { providerId: this.config.providerId } : {})
          })
        )
        .catch(async (error: unknown) => {
          // Preserve usage history when the worker cannot start.
          console.warn(`${this.config.logTag} Reading the usage cache on the main thread:`, error)
          fallback = true
          return {
            reportText: await readFile(cacheFile, 'utf-8'),
            migrated: false,
            reportIntegrityVerified: false
          }
        })
      if (reportText === null) {
        return
      }
      const parsed: State = JSON.parse(reportText)
      this.inlineCache.active =
        fallback &&
        !('usageIntegrity' in parsed) &&
        Array.isArray(parsed[this.config.sourceKey]) &&
        parsed[this.config.sourceKey].length > 0
      await this.applyReport(reportText, parsed, !fallback && reportIntegrityVerified === true)
      if (migrated) {
        // Future launches can read the compact report synchronously.
        await this.writeToDisk().catch(() => {})
      }
    } catch (error) {
      console.error(`${this.config.logTag} Failed to load persisted state, starting fresh:`, error)
    }
  }

  private normalizeReport(parsed: State): State {
    const defaults = this.config.createDefaultState()
    return this.config.normalizeState({
      ...defaults,
      ...parsed,
      [this.config.sourceKey]: [],
      scanState: { ...defaults.scanState, ...parsed.scanState }
    })
  }

  private async runScan(): Promise<void> {
    if (this.scanPromise) {
      await this.scanPromise
      return
    }

    this.state.scanState.lastScanStartedAt = Date.now()
    this.state.scanState.lastScanError = null

    // Assign before yielding so concurrent refreshes share one scan.
    this.scanPromise = (async () => {
      try {
        const repos = this.store.getRepos()
        const worktreesByRepo = loadKnownUsageWorktreesByRepo(this.store, repos)
        const worktreeFingerprint = getUsageWorktreeFingerprint(worktreesByRepo)
        const result = await this.config.scan(createWorktreeRefs(repos, worktreesByRepo), {
          path: usageSourceCachePath(this.config.resolveCacheFile()),
          schemaVersion: this.schemaVersion,
          worktreeFingerprint,
          reuse: this.state.worktreeFingerprint === worktreeFingerprint
        })
        this.state.sessions = result.sessions
        this.state.dailyAggregates = result.dailyAggregates
        this.state.worktreeFingerprint = worktreeFingerprint
        this.state.schemaVersion = this.schemaVersion
        this.inlineCache.active = false
        this.state.scanState.lastScanCompletedAt = Date.now()
        this.state.scanState.lastScanError = null
        // Persistence failures do not turn a successful source scan into a scan failure.
        await this.writeToDisk().catch(() => {})
        await this.reportTokenUsage()
      } catch (error) {
        this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error)
        await this.writeToDisk().catch(() => {})
      } finally {
        this.scanPromise = null
      }
    })()

    await this.scanPromise
  }

  private async reportTokenUsage(): Promise<void> {
    const config = this.config.tokenUsage
    if (!config || !isTelemetryEnabled() || !this.state.scanState.enabled) {
      return
    }
    try {
      if (!this.tokenReporter) {
        const { dir, name } = parse(this.config.resolveCacheFile())
        this.tokenReporter = new AgentTokenUsageReporter(
          join(dir, `${name}-token-usage.json`),
          config.provider,
          (ids) => this.getAnalyticsSessionIds(ids)
        )
      }
      await this.tokenReporter.report(config.selectSessions(this.state))
    } catch {
      // Reporting failures must not invalidate a successful local usage scan.
      console.warn(
        '[agent-token-usage] Could not report token usage; will retry after the next scan'
      )
    }
  }

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    return getUsageWorktreeFingerprint(loadKnownUsageWorktreesByRepo(this.store, repos))
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
