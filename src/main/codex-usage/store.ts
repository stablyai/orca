/* eslint-disable max-lines -- Why: this store owns Codex analytics persistence, scan policy, and renderer query semantics. Keeping them together prevents the Codex range/scope rules from drifting away from the scanner’s event model. */
import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScanState,
  CodexUsageScope,
  CodexUsageSessionRow,
  CodexUsageSummary
} from '../../shared/codex-usage-types'
import type { Store } from '../persistence'
import { loadKnownUsageWorktreesByRepo, type UsageWorktreeRef } from '../usage-worktree-metadata'
import type { CodexUsagePersistedState } from './types'
import { createWorktreeRefs, scanCodexUsageFiles } from './scanner'

const SCHEMA_VERSION = 2
const STALE_MS = 5 * 60_000

let _codexUsageFile: string | null = null

const MODEL_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 }
}

function getDefaultState(): CodexUsagePersistedState {
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

export function normalizePersistedState(state: CodexUsagePersistedState): CodexUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    // Why: Orca-scoped Codex projections now depend on locationModelBreakdown.
    // Reusing an older cache would silently serve wrong model/session rows
    // until the next forced rescan, so schema changes must invalidate stale
    // persisted analytics instead of best-effort patching partial data.
    return getDefaultState()
  }
  return {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
      locationModelBreakdown: session.locationModelBreakdown ?? []
    }))
  }
}

export function initCodexUsagePath(): void {
  _codexUsageFile = join(app.getPath('userData'), 'orca-codex-usage.json')
}

function getCodexUsageFile(): string {
  if (!_codexUsageFile) {
    _codexUsageFile = join(app.getPath('userData'), 'orca-codex-usage.json')
  }
  return _codexUsageFile
}

function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }

  const lower = model.toLowerCase()
  if (lower === 'gpt-5' || lower === 'gpt-5-codex') {
    return 'gpt-5'
  }
  if (lower.startsWith('gpt-5.1')) {
    return 'gpt-5.1'
  }
  if (lower.startsWith('gpt-5.2')) {
    return 'gpt-5.2'
  }
  if (lower.startsWith('gpt-5.3-codex')) {
    return 'gpt-5.3-codex'
  }
  if (lower.startsWith('gpt-5.4')) {
    return 'gpt-5.4'
  }
  if (lower.startsWith('gpt-5.5')) {
    return 'gpt-5.5'
  }
  return null
}

function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  const clampedCached = Math.min(cachedInputTokens, inputTokens)
  // Why: Codex cached tokens are part of the input bucket. Charge uncached
  // input on (input-cached) so cached tokens are not billed once at full input
  // price and again at cache-read price.
  const nonCachedInputTokens = Math.max(inputTokens - clampedCached, 0)
  return (
    (nonCachedInputTokens * pricing.input +
      clampedCached * pricing.cachedInput +
      outputTokens * pricing.output) /
    1_000_000
  )
}

function getRangeCutoff(range: CodexUsageRange): string | null {
  if (range === 'all') {
    return null
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  now.setDate(now.getDate() - (days - 1))
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getLocalDay(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

type ScopedCodexUsageModelRow = {
  modelKey: string
  modelLabel: string
  hasInferredPricing: boolean
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
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

export class CodexUsageStore {
  private state: CodexUsagePersistedState
  private readonly store: Store
  private scanPromise: Promise<void> | null = null

  constructor(store: Store) {
    this.store = store
    this.state = this.load()
  }

  private load(): CodexUsagePersistedState {
    try {
      const usageFile = getCodexUsageFile()
      if (!existsSync(usageFile)) {
        return getDefaultState()
      }
      const parsed = JSON.parse(readFileSync(usageFile, 'utf-8')) as CodexUsagePersistedState
      return normalizePersistedState({
        ...getDefaultState(),
        ...parsed,
        scanState: {
          ...getDefaultState().scanState,
          ...parsed.scanState
        }
      })
    } catch (error) {
      console.error('[codex-usage] Failed to load persisted state, starting fresh:', error)
      return getDefaultState()
    }
  }

  private writeToDisk(): void {
    const usageFile = getCodexUsageFile()
    const dir = dirname(usageFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${usageFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmpFile, usageFile)
  }

  async setEnabled(enabled: boolean): Promise<CodexUsageScanState> {
    this.state.scanState.enabled = enabled
    this.writeToDisk()
    return this.getScanState()
  }

  getScanState(): CodexUsageScanState {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      hasAnyCodexData: this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    }
  }

  async refresh(force = false): Promise<CodexUsageScanState> {
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
        const result = await scanCodexUsageFiles(
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
        this.writeToDisk()
      } finally {
        this.scanPromise = null
      }
    })()

    await this.scanPromise
  }

  async getSummary(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageSummary> {
    await this.refresh(false)
    const filteredDaily = this.getFilteredDaily(scope, range)
    const filteredSessions = this.getFilteredSessions(scope, range)

    let inputTokens = 0
    let cachedInputTokens = 0
    let outputTokens = 0
    let reasoningOutputTokens = 0
    let totalTokens = 0
    let events = 0
    let estimatedCostUsd = 0
    let hasAnyBillableCost = false
    const byModel = new Map<string, number>()
    const byProject = new Map<string, number>()

    for (const row of filteredDaily) {
      inputTokens += row.inputTokens
      cachedInputTokens += row.cachedInputTokens
      outputTokens += row.outputTokens
      reasoningOutputTokens += row.reasoningOutputTokens
      totalTokens += row.totalTokens
      events += row.eventCount
      byModel.set(
        row.model ?? 'Unknown model',
        (byModel.get(row.model ?? 'Unknown model') ?? 0) + row.totalTokens
      )
      byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
      const cost = estimateCostUsd(
        row.model,
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens
      )
      if (cost !== null) {
        hasAnyBillableCost = true
        estimatedCostUsd += cost
      }
    }

    const topModel =
      [...byModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
    const topProject =
      [...byProject.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null

    return {
      scope,
      range,
      sessions: filteredSessions.length,
      events,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      estimatedCostUsd: hasAnyBillableCost ? estimatedCostUsd : null,
      topModel,
      topProject,
      hasAnyCodexData: filteredSessions.length > 0 || filteredDaily.length > 0
    }
  }

  async getDaily(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageDailyPoint[]> {
    await this.refresh(false)
    const byDay = new Map<string, CodexUsageDailyPoint>()
    for (const row of this.getFilteredDaily(scope, range)) {
      const existing = byDay.get(row.day) ?? {
        day: row.day,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0
      }
      existing.inputTokens += row.inputTokens
      existing.cachedInputTokens += row.cachedInputTokens
      existing.outputTokens += row.outputTokens
      existing.reasoningOutputTokens += row.reasoningOutputTokens
      existing.totalTokens += row.totalTokens
      byDay.set(row.day, existing)
    }
    return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
  }

  async getBreakdown(
    scope: CodexUsageScope,
    range: CodexUsageRange,
    kind: CodexUsageBreakdownKind
  ): Promise<CodexUsageBreakdownRow[]> {
    await this.refresh(false)
    const rows = new Map<string, CodexUsageBreakdownRow>()
    const filteredDaily = this.getFilteredDaily(scope, range)
    const filteredSessions = this.getFilteredSessions(scope, range)

    for (const daily of filteredDaily) {
      const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
      const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
      const existing = rows.get(key) ?? {
        key,
        label,
        sessions: 0,
        events: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        hasInferredPricing: false
      }
      existing.events += daily.eventCount
      existing.inputTokens += daily.inputTokens
      existing.cachedInputTokens += daily.cachedInputTokens
      existing.outputTokens += daily.outputTokens
      existing.reasoningOutputTokens += daily.reasoningOutputTokens
      existing.totalTokens += daily.totalTokens
      existing.hasInferredPricing ||= daily.hasInferredPricing
      rows.set(key, existing)
    }

    for (const session of filteredSessions) {
      if (kind === 'model') {
        const seen = new Set<string>()
        for (const model of this.getScopedSessionModels(session, scope)) {
          if (seen.has(model.modelKey)) {
            continue
          }
          seen.add(model.modelKey)
          const row = rows.get(model.modelKey)
          if (row) {
            row.sessions++
          }
        }
        continue
      }
      const matchingLocations = session.locationBreakdown.filter((entry) =>
        scope === 'all' ? true : entry.worktreeId !== null
      )
      const seen = new Set<string>()
      for (const location of matchingLocations) {
        if (seen.has(location.locationKey)) {
          continue
        }
        seen.add(location.locationKey)
        const row = rows.get(location.locationKey)
        if (row) {
          row.sessions++
        }
      }
    }

    for (const row of rows.values()) {
      row.estimatedCostUsd = estimateCostUsd(
        kind === 'model' ? row.key : null,
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens
      )
    }

    return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  }

  async getRecentSessions(
    scope: CodexUsageScope,
    range: CodexUsageRange,
    limit = 12
  ): Promise<CodexUsageSessionRow[]> {
    await this.refresh(false)
    return this.getFilteredSessions(scope, range)
      .slice(0, limit)
      .map((session) => {
        const matchingLocations = session.locationBreakdown.filter((entry) =>
          scope === 'all' ? true : entry.worktreeId !== null
        )
        const scopedLocations =
          matchingLocations.length > 0 ? matchingLocations : session.locationBreakdown
        const totals = scopedLocations.reduce(
          (acc, entry) => {
            acc.events += entry.eventCount
            acc.inputTokens += entry.inputTokens
            acc.cachedInputTokens += entry.cachedInputTokens
            acc.outputTokens += entry.outputTokens
            acc.reasoningOutputTokens += entry.reasoningOutputTokens
            acc.totalTokens += entry.totalTokens
            acc.hasInferredPricing ||= entry.hasInferredPricing
            return acc
          },
          {
            events: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            hasInferredPricing: false
          }
        )
        const durationMinutes = Math.max(
          0,
          Math.round(
            (new Date(session.lastTimestamp).getTime() -
              new Date(session.firstTimestamp).getTime()) /
              60_000
          )
        )
        return {
          sessionId: session.sessionId,
          lastActiveAt: session.lastTimestamp,
          durationMinutes,
          projectLabel:
            scopedLocations.length > 1
              ? 'Multiple locations'
              : (scopedLocations[0]?.projectLabel ?? session.primaryProjectLabel),
          model: this.getScopedSessionPrimaryModel(session, scope),
          events: totals.events,
          inputTokens: totals.inputTokens,
          cachedInputTokens: totals.cachedInputTokens,
          outputTokens: totals.outputTokens,
          reasoningOutputTokens: totals.reasoningOutputTokens,
          totalTokens: totals.totalTokens,
          hasInferredPricing: session.hasInferredPricing || totals.hasInferredPricing
        }
      })
  }

  private getFilteredDaily(scope: CodexUsageScope, range: CodexUsageRange) {
    const cutoff = getRangeCutoff(range)
    return this.state.dailyAggregates.filter((entry) => {
      if (cutoff && entry.day < cutoff) {
        return false
      }
      if (scope === 'orca' && entry.worktreeId === null) {
        return false
      }
      return true
    })
  }

  private getFilteredSessions(scope: CodexUsageScope, range: CodexUsageRange) {
    const cutoff = getRangeCutoff(range)
    return this.state.sessions.filter((session) => {
      const day = getLocalDay(session.lastTimestamp)
      if (!day) {
        return false
      }
      if (cutoff && day < cutoff) {
        return false
      }
      if (scope === 'orca') {
        return session.locationBreakdown.some((entry) => entry.worktreeId !== null)
      }
      return true
    })
  }

  private getScopedSessionModels(
    session: CodexUsagePersistedState['sessions'][number],
    scope: CodexUsageScope
  ): ScopedCodexUsageModelRow[] {
    if (scope === 'all' || session.locationModelBreakdown.length === 0) {
      return session.modelBreakdown
    }

    const rows = new Map<string, ScopedCodexUsageModelRow>()
    for (const entry of session.locationModelBreakdown) {
      if (entry.worktreeId === null) {
        continue
      }
      const existing = rows.get(entry.modelKey) ?? {
        modelKey: entry.modelKey,
        modelLabel: entry.modelLabel,
        hasInferredPricing: false,
        eventCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0
      }
      existing.hasInferredPricing ||= entry.hasInferredPricing
      existing.eventCount += entry.eventCount
      existing.inputTokens += entry.inputTokens
      existing.cachedInputTokens += entry.cachedInputTokens
      existing.outputTokens += entry.outputTokens
      existing.reasoningOutputTokens += entry.reasoningOutputTokens
      existing.totalTokens += entry.totalTokens
      rows.set(entry.modelKey, existing)
    }
    return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  }

  private getScopedSessionPrimaryModel(
    session: CodexUsagePersistedState['sessions'][number],
    scope: CodexUsageScope
  ): string | null {
    const scopedModels = this.getScopedSessionModels(session, scope)
    if (scopedModels.length === 0) {
      return session.primaryModel
    }
    if (scopedModels.length === 1) {
      return scopedModels[0]?.modelLabel ?? null
    }
    return 'Mixed models'
  }

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    const worktreesByRepo = loadKnownUsageWorktreesByRepo(this.store, repos)
    return getWorktreeFingerprint(worktreesByRepo)
  }
}
