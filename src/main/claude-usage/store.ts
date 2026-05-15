/* eslint-disable max-lines -- Why: this store is the single main-process owner for Claude usage persistence, scan gating, and query semantics. Keeping those policy decisions together avoids split-brain range/scope logic across multiple files. */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScanState,
  ClaudeUsageScope,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../../shared/claude-usage-types'
import type { AutomationRunUsage } from '../../shared/automations-types'
import type { Store } from '../persistence'
import { loadKnownUsageWorktreesByRepo, type UsageWorktreeRef } from '../usage-worktree-metadata'
import type { ClaudeUsagePersistedState } from './types'
import { createWorktreeRefs, getSessionProjectLabel, scanClaudeUsageFiles } from './scanner'

const SCHEMA_VERSION = 3
const STALE_MS = 5 * 60_000
const AUTOMATION_ATTRIBUTION_WINDOW_MS = 5 * 60_000

// Why: capture the path after configureDevUserDataPath() but before app.setName()
// mutates Electron's derived userData location, matching the persistence/store pattern.
let _claudeUsageFile: string | null = null

type ClaudeModelPricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  thresholdTokens?: number
  inputAboveThreshold?: number
  outputAboveThreshold?: number
  cacheReadAboveThreshold?: number
  cacheWriteAboveThreshold?: number
}

type AutomationUsageLookupInput = {
  worktreeId: string | null
  terminalSessionId: string | null
  startedAt: number | null
  completedAt: number | null
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
const SONNET_LONG_CONTEXT_PRICING = {
  thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  inputAboveThreshold: 6,
  outputAboveThreshold: 22.5,
  cacheReadAboveThreshold: 0.6,
  cacheWriteAboveThreshold: 7.5
} satisfies Partial<ClaudeModelPricing>

const MODEL_PRICING: Record<string, ClaudeModelPricing> = {
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }
}

const MODEL_ALIASES: Record<string, string> = {
  model_placeholder_m26: 'claude-opus-4-6',
  model_placeholder_m35: 'claude-sonnet-4-6',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4.6-thinking': 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6'
}

function getDefaultState(): ClaudeUsagePersistedState {
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

export function initClaudeUsagePath(): void {
  _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json')
}

function getClaudeUsageFile(): string {
  if (!_claudeUsageFile) {
    _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json')
  }
  return _claudeUsageFile
}

function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  const lower = model
    .toLowerCase()
    .trim()
    .replace(/^anthropic[/:]/, '')
  const alias = MODEL_ALIASES[lower]
  if (alias) {
    return alias
  }
  if (lower.includes('opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (lower.includes('opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (lower.includes('opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (lower.includes('opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (lower.includes('opus-4')) {
    return 'claude-opus-4'
  }
  if (lower.includes('sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (lower.includes('sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (lower.includes('sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (lower.includes('sonnet-3-7') || lower.includes('sonnet-3.7')) {
    return 'claude-sonnet-3-7'
  }
  // Why: legacy version-first IDs like `claude-3-5-sonnet-20241022` are still
  // present in historical Claude Code/SDK logs read off disk. Match them so
  // their cost is not silently dropped from the breakdown.
  if (
    lower.includes('sonnet-3-5') ||
    lower.includes('sonnet-3.5') ||
    lower.includes('3-5-sonnet') ||
    lower.includes('3.5-sonnet')
  ) {
    return 'claude-sonnet-3-5'
  }
  if (lower.includes('haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  if (lower.includes('haiku-3-5') || lower.includes('haiku-3.5')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('3-5-haiku') || lower.includes('3.5-haiku')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('haiku-3')) {
    return 'claude-haiku-3'
  }
  return null
}

function calculateTieredCost(
  tokens: number,
  basePrice: number,
  abovePrice?: number,
  threshold?: number
): number {
  if (threshold === undefined || abovePrice === undefined) {
    return tokens * basePrice
  }
  const belowTokens = Math.min(tokens, threshold)
  const aboveTokens = Math.max(tokens - threshold, 0)
  return belowTokens * basePrice + aboveTokens * abovePrice
}

function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  return (
    (calculateTieredCost(
      inputTokens,
      pricing.input,
      pricing.inputAboveThreshold,
      pricing.thresholdTokens
    ) +
      calculateTieredCost(
        outputTokens,
        pricing.output,
        pricing.outputAboveThreshold,
        pricing.thresholdTokens
      ) +
      calculateTieredCost(
        cacheReadTokens,
        pricing.cacheRead,
        pricing.cacheReadAboveThreshold,
        pricing.thresholdTokens
      ) +
      calculateTieredCost(
        cacheWriteTokens,
        pricing.cacheWrite,
        pricing.cacheWriteAboveThreshold,
        pricing.thresholdTokens
      )) /
    1_000_000
  )
}

function getRangeCutoff(range: ClaudeUsageRange): string | null {
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

export class ClaudeUsageStore {
  private state: ClaudeUsagePersistedState
  private readonly store: Store
  private scanPromise: Promise<void> | null = null

  constructor(store: Store) {
    this.store = store
    this.state = this.load()
  }

  private load(): ClaudeUsagePersistedState {
    try {
      const usageFile = getClaudeUsageFile()
      if (!existsSync(usageFile)) {
        return getDefaultState()
      }
      const parsed = JSON.parse(readFileSync(usageFile, 'utf-8')) as ClaudeUsagePersistedState
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        // Why: scanner semantics affect persisted totals, so old Claude caches
        // must be rebuilt after parser/source changes instead of reused briefly.
        return getDefaultState()
      }
      return {
        ...getDefaultState(),
        ...parsed,
        scanState: {
          ...getDefaultState().scanState,
          ...parsed.scanState
        }
      }
    } catch (error) {
      // Why: Claude usage is a local analytics feature, not primary workspace
      // state. A corrupt cache should degrade to a fresh rebuild instead of
      // preventing Orca from booting, but we leave the file on disk for debugging.
      console.error('[claude-usage] Failed to load persisted state, starting fresh:', error)
      return getDefaultState()
    }
  }

  private writeToDisk(): void {
    const usageFile = getClaudeUsageFile()
    const dir = dirname(usageFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // Why: scans can refresh while the app is in active use. Use the same
    // atomic temp-file pattern as the main store so a crash or concurrent write
    // cannot leave a truncated analytics file as the common failure mode.
    const tmpFile = `${usageFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmpFile, usageFile)
  }

  async setEnabled(enabled: boolean): Promise<ClaudeUsageScanState> {
    this.state.scanState.enabled = enabled
    this.writeToDisk()
    return this.getScanState()
  }

  getScanState(): ClaudeUsageScanState {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      hasAnyClaudeData: this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    }
  }

  async refresh(force = false): Promise<ClaudeUsageScanState> {
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
        const result = await scanClaudeUsageFiles(
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

  async getSummary(scope: ClaudeUsageScope, range: ClaudeUsageRange): Promise<ClaudeUsageSummary> {
    await this.refresh(false)
    const filteredDaily = this.getFilteredDaily(scope, range)
    const filteredSessions = this.getFilteredSessions(scope, range)

    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let turns = 0
    let zeroCacheReadTurns = 0
    const byModel = new Map<string, number>()
    const byProject = new Map<string, number>()
    let estimatedCostUsd = 0
    let hasAnyBillableCost = false

    for (const row of filteredDaily) {
      inputTokens += row.inputTokens
      outputTokens += row.outputTokens
      cacheReadTokens += row.cacheReadTokens
      cacheWriteTokens += row.cacheWriteTokens
      turns += row.turnCount
      zeroCacheReadTurns += row.zeroCacheReadTurnCount
      const modelKey = row.model ?? 'Unknown model'
      byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + row.inputTokens + row.outputTokens)
      byProject.set(
        row.projectLabel,
        (byProject.get(row.projectLabel) ?? 0) + row.inputTokens + row.outputTokens
      )
      const cost = estimateCostUsd(
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens
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
      turns,
      zeroCacheReadTurns,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheReuseRate:
        inputTokens + cacheReadTokens > 0
          ? cacheReadTokens / (inputTokens + cacheReadTokens)
          : null,
      estimatedCostUsd: hasAnyBillableCost ? estimatedCostUsd : null,
      topModel,
      topProject,
      // Why: the empty-state UX is scope/range specific. Using global persisted
      // data here makes the Orca-only view render empty charts instead of the
      // intended "no usage for this scope" message when only off-Orca logs exist.
      hasAnyClaudeData: filteredSessions.length > 0 || filteredDaily.length > 0
    }
  }

  async getDaily(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange
  ): Promise<ClaudeUsageDailyPoint[]> {
    await this.refresh(false)
    const byDay = new Map<string, ClaudeUsageDailyPoint>()
    for (const row of this.getFilteredDaily(scope, range)) {
      const existing = byDay.get(row.day) ?? {
        day: row.day,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
      existing.inputTokens += row.inputTokens
      existing.outputTokens += row.outputTokens
      existing.cacheReadTokens += row.cacheReadTokens
      existing.cacheWriteTokens += row.cacheWriteTokens
      byDay.set(row.day, existing)
    }
    return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
  }

  async getBreakdown(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    kind: ClaudeUsageBreakdownKind
  ): Promise<ClaudeUsageBreakdownRow[]> {
    await this.refresh(false)
    const rows = new Map<string, ClaudeUsageBreakdownRow>()
    const filteredDaily = this.getFilteredDaily(scope, range)
    const filteredSessions = this.getFilteredSessions(scope, range)

    for (const daily of filteredDaily) {
      const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
      const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
      const existing = rows.get(key) ?? {
        key,
        label,
        sessions: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: null
      }
      existing.turns += daily.turnCount
      existing.inputTokens += daily.inputTokens
      existing.outputTokens += daily.outputTokens
      existing.cacheReadTokens += daily.cacheReadTokens
      existing.cacheWriteTokens += daily.cacheWriteTokens
      rows.set(key, existing)
    }

    for (const session of filteredSessions) {
      if (kind === 'model') {
        const key = session.model ?? 'unknown'
        const row = rows.get(key)
        if (row) {
          row.sessions++
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
      if (kind === 'model') {
        row.estimatedCostUsd = estimateCostUsd(
          row.key,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens
        )
      }
    }

    return [...rows.values()].sort((left, right) => {
      const leftTotal = left.inputTokens + left.outputTokens
      const rightTotal = right.inputTokens + right.outputTokens
      return rightTotal - leftTotal
    })
  }

  async getRecentSessions(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    limit = 12
  ): Promise<ClaudeUsageSessionRow[]> {
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
            acc.turns += entry.turnCount
            acc.inputTokens += entry.inputTokens
            acc.outputTokens += entry.outputTokens
            acc.cacheReadTokens += entry.cacheReadTokens
            acc.cacheWriteTokens += entry.cacheWriteTokens
            return acc
          },
          {
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
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
          projectLabel: getSessionProjectLabel(scopedLocations),
          branch: session.lastGitBranch,
          model: session.model,
          turns: totals.turns,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens
        }
      })
  }

  async getAutomationRunUsage(input: AutomationUsageLookupInput): Promise<AutomationRunUsage> {
    const collectedAt = Date.now()
    const unavailable = (
      unavailableReason: AutomationRunUsage['unavailableReason'],
      unavailableMessage: string
    ): AutomationRunUsage => ({
      status: 'unavailable',
      provider: 'claude',
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      estimatedCostSource: null,
      providerSessionId: null,
      attribution: null,
      collectedAt,
      unavailableReason,
      unavailableMessage
    })

    if (!this.state.scanState.enabled) {
      return unavailable('usage_not_enabled', 'Claude usage tracking is not enabled.')
    }
    if (!input.worktreeId || !input.startedAt || !input.completedAt) {
      return unavailable('no_matching_session', 'Run session metadata is incomplete.')
    }

    const scanState = await this.refresh(true)
    if (scanState.lastScanError) {
      return unavailable('scan_failed', scanState.lastScanError)
    }

    const windowStart = input.startedAt - AUTOMATION_ATTRIBUTION_WINDOW_MS
    const windowEnd = input.completedAt + AUTOMATION_ATTRIBUTION_WINDOW_MS
    const candidates = this.state.sessions.filter((session) => {
      const first = new Date(session.firstTimestamp).getTime()
      const last = new Date(session.lastTimestamp).getTime()
      if (!Number.isFinite(first) || !Number.isFinite(last)) {
        return false
      }
      if (session.sessionId === input.terminalSessionId) {
        return true
      }
      if (first < windowStart || first > windowEnd || last > windowEnd) {
        return false
      }
      return session.locationBreakdown.some((entry) => entry.worktreeId === input.worktreeId)
    })

    if (candidates.length === 0) {
      return unavailable('no_matching_session', 'No Claude usage session matched this run.')
    }
    if (candidates.length > 1) {
      return unavailable(
        'ambiguous_session',
        'Multiple Claude usage sessions matched this run window.'
      )
    }

    const session = candidates[0]
    const scopedLocations = session.locationBreakdown.filter(
      (entry) => entry.worktreeId === input.worktreeId
    )
    const locations = scopedLocations.length > 0 ? scopedLocations : session.locationBreakdown
    const totals = locations.reduce(
      (acc, entry) => {
        acc.turns += entry.turnCount
        acc.inputTokens += entry.inputTokens
        acc.outputTokens += entry.outputTokens
        acc.cacheReadTokens += entry.cacheReadTokens
        acc.cacheWriteTokens += entry.cacheWriteTokens
        return acc
      },
      {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    )
    const estimatedCostUsd = estimateCostUsd(
      session.model,
      totals.inputTokens,
      totals.outputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens
    )

    return {
      status: 'known',
      provider: 'claude',
      model: session.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      reasoningOutputTokens: null,
      totalTokens:
        totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
      estimatedCostUsd,
      estimatedCostSource: estimatedCostUsd === null ? null : 'api_equivalent',
      providerSessionId: session.sessionId,
      // Why: Orca terminal tab ids and Claude usage session ids are different
      // systems today, so attribution is intentionally limited to one local
      // provider session in the run's worktree/time window.
      attribution: 'provider_session_time_window',
      collectedAt,
      unavailableReason: null,
      unavailableMessage: null
    }
  }

  private getFilteredDaily(scope: ClaudeUsageScope, range: ClaudeUsageRange) {
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

  private getFilteredSessions(scope: ClaudeUsageScope, range: ClaudeUsageRange) {
    const cutoff = getRangeCutoff(range)
    return this.state.sessions.filter((session) => {
      // Why: daily aggregates use local calendar days, so session filtering has
      // to use the same conversion or the sessions table/counts can disagree
      // with the chart around UTC day boundaries.
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

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    const worktreesByRepo = loadKnownUsageWorktreesByRepo(this.store, repos)
    return getWorktreeFingerprint(worktreesByRepo)
  }
}
