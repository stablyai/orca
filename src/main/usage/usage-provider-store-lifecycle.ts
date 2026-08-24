import { existsSync, readFileSync } from 'node:fs'
import type { Store } from '../persistence'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import { loadKnownUsageWorktreesByRepo } from '../usage-worktree-metadata'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import { createWorktreeRefs, getUsageWorktreeFingerprint } from './usage-worktree-refs'
import {
  loadUsageSourceCache,
  resolveUsageSourceCacheFile,
  serializeUsageSourceCache
} from './usage-provider-source-cache'

const STALE_MS = 5 * 60_000

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

type UsageProviderScanProjection<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>
> = Pick<State, SourceKey | 'sessions' | 'dailyAggregates'>

type UsageProviderStoreLifecycleConfig<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> = {
  logTag: string
  resolveCacheFile: () => string
  createDefaultState: () => State
  normalizeState: (state: State) => State
  sourceKey: SourceKey
  dataPresenceKey: DataPresenceKey
  jsonIndent?: number
  scan: (
    worktrees: UsageScanWorktreeRef[],
    previous: State[SourceKey]
  ) => Promise<UsageProviderScanProjection<SourceKey, State>>
}

type PublicUsageProviderScanState<DataPresenceKey extends string> = UsageProviderScanState & {
  isScanning: boolean
} & Record<DataPresenceKey, boolean>

export abstract class UsageProviderStoreLifecycle<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> {
  protected state: State
  private scanPromise: Promise<void> | null = null
  private readonly writer: UsageCacheSnapshotWriter
  private readonly sourceWriter: UsageCacheSnapshotWriter
  private legacySource: State[SourceKey] | null = null
  private migrationPromise: Promise<void> | null = null

  constructor(
    private readonly store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
    private readonly config: UsageProviderStoreLifecycleConfig<SourceKey, State, DataPresenceKey>
  ) {
    this.writer = new UsageCacheSnapshotWriter(config.logTag, config.resolveCacheFile)
    this.sourceWriter = new UsageCacheSnapshotWriter(config.logTag, () =>
      resolveUsageSourceCacheFile(config.resolveCacheFile())
    )
    this.state = this.load()
    const loadedSource = Array.isArray(this.state[this.config.sourceKey])
      ? this.state[this.config.sourceKey]
      : this.emptySourceState()
    this.state[this.config.sourceKey] = this.emptySourceState()
    if (loadedSource.length > 0) {
      this.legacySource = loadedSource
      this.migrationPromise = this.writePartitionedState(loadedSource)
        .catch(() => {})
        .finally(() => {
          if (this.legacySource === loadedSource) {
            this.legacySource = null
          }
        })
    }
  }

  getScanState(): PublicUsageProviderScanState<DataPresenceKey> {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      [this.config.dataPresenceKey]:
        this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    } as PublicUsageProviderScanState<DataPresenceKey>
  }

  /** Await queued cache writes so quit does not drop the final snapshot. */
  flush(): Promise<void> {
    return Promise.all([
      this.migrationPromise,
      this.writer.flush(),
      this.sourceWriter.flush()
    ]).then(() => undefined)
  }

  async setEnabled(enabled: boolean): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
    this.state.scanState.enabled = enabled
    await this.writeHotState()
    return this.getScanState()
  }

  async refresh(force = false): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
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

  protected writeHotState(): Promise<void> {
    return this.writer.write(() =>
      JSON.stringify(
        { ...this.state, [this.config.sourceKey]: this.emptySourceState() },
        null,
        this.config.jsonIndent
      )
    )
  }

  private load(): State {
    const defaults = this.config.createDefaultState()
    try {
      const cacheFile = this.config.resolveCacheFile()
      if (!existsSync(cacheFile)) {
        return defaults
      }
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf-8')) as State
      return this.config.normalizeState({
        ...defaults,
        ...parsed,
        scanState: { ...defaults.scanState, ...parsed.scanState }
      })
    } catch (error) {
      console.error(`${this.config.logTag} Failed to load persisted state, starting fresh:`, error)
      return defaults
    }
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
        const result = await this.config.scan(
          createWorktreeRefs(repos, worktreesByRepo),
          this.state.worktreeFingerprint === worktreeFingerprint
            ? this.loadPreviousSource()
            : this.emptySourceState()
        )
        const nextSource = result[this.config.sourceKey]
        this.state[this.config.sourceKey] = nextSource
        this.state.sessions = result.sessions
        this.state.dailyAggregates = result.dailyAggregates
        this.state.worktreeFingerprint = worktreeFingerprint
        this.state.scanState.lastScanCompletedAt = Date.now()
        this.state.scanState.lastScanError = null
        // Persistence failures do not turn a successful source scan into a scan failure.
        await this.writePartitionedState(nextSource).catch(() => {})
        if (this.state[this.config.sourceKey] === nextSource) {
          this.state[this.config.sourceKey] = this.emptySourceState()
        }
      } catch (error) {
        this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error)
        await this.writeHotState().catch(() => {})
      } finally {
        this.scanPromise = null
      }
    })()

    await this.scanPromise
  }

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    return getUsageWorktreeFingerprint(loadKnownUsageWorktreesByRepo(this.store, repos))
  }

  private emptySourceState(): State[SourceKey] {
    return this.config.createDefaultState()[this.config.sourceKey]
  }

  private loadPreviousSource(): State[SourceKey] {
    const resident = this.state[this.config.sourceKey]
    if (resident.length > 0) {
      return resident
    }
    if (this.legacySource) {
      return this.legacySource
    }
    return (loadUsageSourceCache({
      cacheFile: this.config.resolveCacheFile(),
      sourceKey: this.config.sourceKey,
      schemaVersion: this.state.schemaVersion,
      worktreeFingerprint: this.state.worktreeFingerprint,
      logTag: this.config.logTag
    }) ?? this.emptySourceState()) as State[SourceKey]
  }

  private async writePartitionedState(sources: State[SourceKey]): Promise<void> {
    const snapshot = {
      schemaVersion: this.state.schemaVersion,
      worktreeFingerprint: this.state.worktreeFingerprint,
      sources
    }
    await this.sourceWriter.write(() =>
      serializeUsageSourceCache({
        sourceKey: this.config.sourceKey,
        ...snapshot,
        jsonIndent: this.config.jsonIndent
      })
    )
    await this.writeHotState()
  }
}
