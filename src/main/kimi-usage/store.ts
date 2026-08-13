import { app } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type {
  KimiUsageBreakdownKind,
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageRange,
  KimiUsageScanState,
  KimiUsageScope,
  KimiUsageSessionRow,
  KimiUsageSnapshot,
  KimiUsageSummary
} from '../../shared/kimi-usage-types'
import type { Store } from '../persistence'
import { loadKnownUsageWorktreesByRepo, type UsageWorktreeRef } from '../usage-worktree-metadata'
import type { KimiUsagePersistedState } from './types'
import { createWorktreeRefs, scanKimiUsageFiles } from './scanner'
import {
  buildKimiRecentSessions,
  buildKimiUsageBreakdown,
  buildKimiUsageDaily,
  buildKimiUsageSnapshot,
  buildKimiUsageSummary
} from './query'

const SCHEMA_VERSION = 1
const STALE_MS = 5 * 60_000

let _kimiUsageFile: string | null = null

function getDefaultState(): KimiUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

export function normalizePersistedState(state: KimiUsagePersistedState): KimiUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return getDefaultState()
  }
  return {
    ...state,
    processedFiles: state.processedFiles.map((file) => ({
      ...file,
      wirePath: file.wirePath ?? null,
      wireMtimeMs: file.wireMtimeMs ?? null,
      wireSize: file.wireSize ?? null
    })),
    sessions: state.sessions.map((session) => ({
      ...session,
      locationModelBreakdown: session.locationModelBreakdown ?? []
    }))
  }
}

export function initKimiUsagePath(): void {
  _kimiUsageFile = join(app.getPath('userData'), 'orca-kimi-usage.json')
}

function getKimiUsageFile(): string {
  if (!_kimiUsageFile) {
    _kimiUsageFile = join(app.getPath('userData'), 'orca-kimi-usage.json')
  }
  return _kimiUsageFile
}

function getWorktreeFingerprint(worktreesByRepo: Map<string, UsageWorktreeRef[]>): string {
  const rows = [...worktreesByRepo.entries()]
    .flatMap(([repoId, worktrees]) =>
      worktrees.map((worktree) =>
        JSON.stringify({
          repoId,
          worktreeId: worktree.worktreeId,
          path: worktree.path,
          displayName: worktree.displayName
        })
      )
    )
    .sort()
  return JSON.stringify(rows)
}

export class KimiUsageStore {
  private state: KimiUsagePersistedState
  private readonly store: Store
  private scanPromise: Promise<void> | null = null

  constructor(store: Store) {
    this.store = store
    this.state = this.load()
  }

  private load(): KimiUsagePersistedState {
    try {
      const usageFile = getKimiUsageFile()
      if (!existsSync(usageFile)) {
        return getDefaultState()
      }
      const parsed = JSON.parse(readFileSync(usageFile, 'utf-8')) as KimiUsagePersistedState
      return normalizePersistedState({
        ...getDefaultState(),
        ...parsed,
        scanState: {
          ...getDefaultState().scanState,
          ...parsed.scanState
        }
      })
    } catch (error) {
      console.error('[kimi-usage] Failed to load persisted state, starting fresh:', error)
      return getDefaultState()
    }
  }

  private writeToDisk(): void {
    const usageFile = getKimiUsageFile()
    const dir = dirname(usageFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${usageFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmpFile, usageFile)
  }

  async setEnabled(enabled: boolean): Promise<KimiUsageScanState> {
    this.state.scanState.enabled = enabled
    this.writeToDisk()
    return this.getScanState()
  }

  async flush(): Promise<void> {
    await this.scanPromise
    this.writeToDisk()
  }

  getScanState(): KimiUsageScanState {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      hasAnyKimiData: this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    }
  }

  getSnapshot(
    scope: KimiUsageScope,
    range: KimiUsageRange,
    recentSessionLimit = 10
  ): KimiUsageSnapshot {
    return buildKimiUsageSnapshot(this.state, this.getScanState(), scope, range, recentSessionLimit)
  }

  async refresh(force = false): Promise<KimiUsageScanState> {
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

  private async runScan(): Promise<void> {
    if (this.scanPromise) {
      await this.scanPromise
      return
    }

    this.state.scanState.lastScanStartedAt = Date.now()
    this.state.scanState.lastScanError = null
    this.writeToDisk()

    this.scanPromise = (async () => {
      try {
        const repos = this.store.getRepos()
        const worktreesByRepo = loadKnownUsageWorktreesByRepo(this.store, repos)
        const worktreeFingerprint = getWorktreeFingerprint(worktreesByRepo)
        const result = await scanKimiUsageFiles(
          createWorktreeRefs(repos, worktreesByRepo),
          this.state.worktreeFingerprint === worktreeFingerprint ? this.state.processedFiles : []
        )
        this.state.processedFiles = result.processedFiles
        this.state.sessions = result.sessions
        this.state.dailyAggregates = result.dailyAggregates
        this.state.worktreeFingerprint = worktreeFingerprint
        this.state.scanState.lastScanCompletedAt = Date.now()
        this.state.scanState.lastScanError = null
        this.writeToDisk()
      } catch (error) {
        this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error)
        try {
          this.writeToDisk()
        } catch (writeError) {
          console.error('[kimi-usage] Failed to persist scan error:', writeError)
        }
      } finally {
        this.scanPromise = null
      }
    })()

    await this.scanPromise
  }

  async getSummary(scope: KimiUsageScope, range: KimiUsageRange): Promise<KimiUsageSummary> {
    await this.refresh(false)
    return buildKimiUsageSummary(this.state, scope, range)
  }

  async getDaily(scope: KimiUsageScope, range: KimiUsageRange): Promise<KimiUsageDailyPoint[]> {
    await this.refresh(false)
    return buildKimiUsageDaily(this.state, scope, range)
  }

  async getBreakdown(
    scope: KimiUsageScope,
    range: KimiUsageRange,
    kind: KimiUsageBreakdownKind
  ): Promise<KimiUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildKimiUsageBreakdown(this.state, scope, range, kind)
  }

  async getRecentSessions(
    scope: KimiUsageScope,
    range: KimiUsageRange,
    limit = 10
  ): Promise<KimiUsageSessionRow[]> {
    await this.refresh(false)
    return buildKimiRecentSessions(this.state, scope, range, limit)
  }

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    return getWorktreeFingerprint(loadKnownUsageWorktreesByRepo(this.store, repos))
  }
}
