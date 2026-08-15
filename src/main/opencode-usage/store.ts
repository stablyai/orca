/* eslint-disable max-lines -- Why: OpenCode cost normalization and range, scope, and breakdown policies remain one cohesive store. */
import { app } from 'electron'
import { join } from 'node:path'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageRange,
  OpenCodeUsageScope,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSnapshot,
  OpenCodeUsageSummary
} from '../../shared/opencode-usage-types'
import type { Store } from '../persistence'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsagePersistedState } from './types'
import { OPENCODE_USAGE_SCHEMA_VERSION, openCodeUsageProvider } from './opencode-usage-provider'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'

const SCHEMA_VERSION = OPENCODE_USAGE_SCHEMA_VERSION

let _openCodeUsageFile: string | null = null

function getDefaultState(): OpenCodeUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedDatabases: [],
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

export function normalizePersistedState(
  state: OpenCodeUsagePersistedState
): OpenCodeUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return getDefaultState()
  }
  return {
    ...state,
    processedDatabases: (state.processedDatabases ?? []).map((database) => ({
      ...database,
      sessions: (database.sessions ?? []).map(normalizeSessionCost),
      dailyAggregates: (database.dailyAggregates ?? []).map(normalizeDailyAggregateCost)
    })),
    sessions: state.sessions.map(normalizeSessionCost),
    dailyAggregates: state.dailyAggregates.map(normalizeDailyAggregateCost)
  }
}

export function initOpenCodeUsagePath(): void {
  _openCodeUsageFile = join(app.getPath('userData'), 'orca-opencode-usage.json')
}

function getOpenCodeUsageFile(): string {
  if (!_openCodeUsageFile) {
    _openCodeUsageFile = join(app.getPath('userData'), 'orca-opencode-usage.json')
  }
  return _openCodeUsageFile
}

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

function normalizeDailyAggregateCost(
  entry: OpenCodeUsageDailyAggregate
): OpenCodeUsageDailyAggregate {
  return {
    ...entry,
    estimatedCostUsd: entry.estimatedCostUsd ?? null
  }
}

function normalizeSessionCost(
  session: OpenCodeUsagePersistedState['sessions'][number]
): OpenCodeUsagePersistedState['sessions'][number] {
  return {
    ...session,
    estimatedCostUsd: session.estimatedCostUsd ?? null,
    locationBreakdown: (session.locationBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    })),
    modelBreakdown: (session.modelBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    })),
    locationModelBreakdown: (session.locationModelBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    }))
  }
}

export class OpenCodeUsageStore extends UsageProviderStoreLifecycle<
  'processedDatabases',
  OpenCodeUsagePersistedState,
  'hasAnyOpenCodeData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[opencode-usage]',
      resolveCacheFile: getOpenCodeUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedDatabases',
      dataPresenceKey: 'hasAnyOpenCodeData',
      jsonIndent: 2,
      scan: openCodeUsageProvider.scan
    })
  }

  getSnapshot(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    recentSessionLimit = 10
  ): OpenCodeUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: this.buildSummary(scope, range),
      daily: this.buildDaily(scope, range),
      modelBreakdown: this.buildBreakdown(scope, range, 'model'),
      projectBreakdown: this.buildBreakdown(scope, range, 'project'),
      recentSessions: this.buildRecentSessions(scope, range, recentSessionLimit)
    }
  }

  async getSummary(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): Promise<OpenCodeUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  private buildSummary(scope: OpenCodeUsageScope, range: OpenCodeUsageRange): OpenCodeUsageSummary {
    const filteredDaily = this.getFilteredDaily(scope, range)
    const filteredSessions = this.getFilteredSessions(scope, range)

    let inputTokens = 0
    let cachedInputTokens = 0
    let outputTokens = 0
    let reasoningOutputTokens = 0
    let totalTokens = 0
    let events = 0
    let estimatedCostUsd: number | null = null
    const byModel = new Map<string, number>()
    const byProject = new Map<string, number>()

    for (const row of filteredDaily) {
      inputTokens += row.inputTokens
      cachedInputTokens += row.cachedInputTokens
      outputTokens += row.outputTokens
      reasoningOutputTokens += row.reasoningOutputTokens
      totalTokens += row.totalTokens
      events += row.eventCount
      estimatedCostUsd = addCost(estimatedCostUsd, row.estimatedCostUsd)
      byModel.set(
        row.model ?? 'Unknown model',
        (byModel.get(row.model ?? 'Unknown model') ?? 0) + row.totalTokens
      )
      byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
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
      estimatedCostUsd,
      topModel,
      topProject,
      hasAnyOpenCodeData: filteredSessions.length > 0 || filteredDaily.length > 0
    }
  }

  async getDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): Promise<OpenCodeUsageDailyPoint[]> {
    await this.refresh(false)
    return this.buildDaily(scope, range)
  }

  private buildDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageDailyPoint[] {
    const byDay = new Map<string, OpenCodeUsageDailyPoint>()
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
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    kind: OpenCodeUsageBreakdownKind
  ): Promise<OpenCodeUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  private buildBreakdown(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    kind: OpenCodeUsageBreakdownKind
  ): OpenCodeUsageBreakdownRow[] {
    const rows = new Map<string, OpenCodeUsageBreakdownRow>()
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
        estimatedCostUsd: null
      }
      existing.events += daily.eventCount
      existing.inputTokens += daily.inputTokens
      existing.cachedInputTokens += daily.cachedInputTokens
      existing.outputTokens += daily.outputTokens
      existing.reasoningOutputTokens += daily.reasoningOutputTokens
      existing.totalTokens += daily.totalTokens
      existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, daily.estimatedCostUsd)
      rows.set(key, existing)
    }

    if (kind === 'model') {
      for (const session of filteredSessions) {
        for (const entry of session.modelBreakdown) {
          const row = rows.get(entry.modelKey)
          if (row) {
            row.sessions++
          }
        }
      }
    } else {
      for (const session of filteredSessions) {
        for (const entry of session.locationBreakdown) {
          const row = rows.get(entry.locationKey)
          if (row) {
            row.sessions++
          }
        }
      }
    }

    return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  }

  async getRecentSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    limit = 10
  ): Promise<OpenCodeUsageSessionRow[]> {
    await this.refresh(false)
    return this.buildRecentSessions(scope, range, limit)
  }

  private buildRecentSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    limit = 10
  ): OpenCodeUsageSessionRow[] {
    return this.getFilteredSessions(scope, range)
      .slice(0, limit)
      .map(
        (session): OpenCodeUsageSessionRow => ({
          sessionId: session.sessionId,
          lastActiveAt: session.lastTimestamp,
          durationMinutes: Math.max(
            0,
            Math.round(
              (new Date(session.lastTimestamp).getTime() -
                new Date(session.firstTimestamp).getTime()) /
                60_000
            )
          ),
          projectLabel: session.primaryProjectLabel,
          model: session.primaryModel,
          events: session.eventCount,
          inputTokens: session.totalInputTokens,
          cachedInputTokens: session.totalCachedInputTokens,
          outputTokens: session.totalOutputTokens,
          reasoningOutputTokens: session.totalReasoningOutputTokens,
          totalTokens: session.totalTokens
        })
      )
  }

  private getFilteredDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageDailyAggregate[] {
    const cutoff = getUsageRangeCutoff(range)
    return this.state.dailyAggregates.filter((row) => {
      if (scope === 'orca' && !row.worktreeId) {
        return false
      }
      if (cutoff && row.day < cutoff) {
        return false
      }
      return true
    })
  }

  private getFilteredSessions(scope: OpenCodeUsageScope, range: OpenCodeUsageRange) {
    const cutoff = getUsageRangeCutoff(range)
    return this.state.sessions.filter((session) => {
      if (scope === 'orca' && !session.primaryWorktreeId) {
        return false
      }
      if (cutoff) {
        const day = getLocalUsageDay(session.lastTimestamp)
        if (!day || day < cutoff) {
          return false
        }
      }
      return true
    })
  }
}
