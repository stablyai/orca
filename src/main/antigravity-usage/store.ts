import { join } from 'node:path'
import type {
  AntigravityUsageBreakdownKind,
  AntigravityUsageBreakdownRow,
  AntigravityUsageDailyPoint,
  AntigravityUsageRange,
  AntigravityUsageScope,
  AntigravityUsageSessionRow,
  AntigravityUsageSnapshot,
  AntigravityUsageSummary
} from '../../shared/agent-usage/analytics/antigravity-usage-types'
import type { UsageStoreHost } from '../usage/usage-store-host'
import { UsageProviderStoreLifecycle } from '../usage/provider-lifecycle/usage-provider-store-lifecycle'
import {
  scanAntigravityUsageFilesViaWorker,
  splitUsageCacheFileViaWorker
} from '../usage/scan-worker/usage-scan-worker-spawn'
import {
  filterUsageDaily,
  filterUsageSessions
} from '../usage/reporting/range-query/usage-scope-filters'
import { listRunningWslHomeDirsUnlessStopped } from '../wsl/discovery/wsl-home-unless-stopped'
import { resolveAntigravityUsageBrainDirs } from './antigravity-transcript-discovery'
import {
  getDefaultAntigravityUsageState,
  normalizeAntigravityUsageState
} from './persisted-state-normalization'
import {
  buildAntigravityUsageBreakdownRows,
  buildAntigravityUsageDailyPoints,
  buildAntigravityUsageRecentSessions,
  buildAntigravityUsageSummary
} from './snapshot-rollups'
import type {
  AntigravityUsageDailyAggregate,
  AntigravityUsagePersistedState,
  AntigravityUsageSession
} from './types'

export class AntigravityUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  AntigravityUsagePersistedState,
  'hasAnyAntigravityData'
> {
  constructor(host: UsageStoreHost) {
    super(host, {
      logTag: '[antigravity-usage]',
      resolveCacheFile: () => join(host.userDataPath, 'orca-antigravity-usage.json'),
      createDefaultState: getDefaultAntigravityUsageState,
      normalizeState: normalizeAntigravityUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyAntigravityData',
      scan: async (worktrees, sourceCache) => {
        const wslHomeDirs =
          process.platform === 'win32'
            ? await listRunningWslHomeDirsUnlessStopped().catch(() => [])
            : []
        const brainDirs = resolveAntigravityUsageBrainDirs({
          userDataPath: host.userDataPath,
          wslHomeDirs
        })
        return scanAntigravityUsageFilesViaWorker(worktrees, sourceCache, brainDirs)
      },
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    recentSessionLimit = 10
  ): AntigravityUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildAntigravityUsageSummary(scope, range, daily, sessions),
      daily: buildAntigravityUsageDailyPoints(daily),
      modelBreakdown: buildAntigravityUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildAntigravityUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildAntigravityUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): Promise<AntigravityUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): Promise<AntigravityUsageDailyPoint[]> {
    await this.refresh(false)
    return buildAntigravityUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    kind: AntigravityUsageBreakdownKind
  ): Promise<AntigravityUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    limit = 10
  ): Promise<AntigravityUsageSessionRow[]> {
    await this.refresh(false)
    return buildAntigravityUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageSummary {
    return buildAntigravityUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange,
    kind: AntigravityUsageBreakdownKind
  ): AntigravityUsageBreakdownRow[] {
    return buildAntigravityUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(
    scope: AntigravityUsageScope,
    range: AntigravityUsageRange
  ): AntigravityUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
