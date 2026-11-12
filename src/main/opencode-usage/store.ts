import { localUsageDay } from '../../shared/usage-history-range'
import { projectEventUsageHistory } from '../usage/usage-history-projection'
import { codexOpenCodeTokenSessions } from '../usage/reporting/token-usage/agent-token-usage'
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
import type { UsageStoreHost } from '../usage/usage-store-host'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedState,
  OpenCodeUsageSession
} from './types'
import { openCodeUsageProvider } from './opencode-usage-provider'
import { getDefaultState, normalizePersistedState } from './persisted-state-normalization'
import {
  filterDailyAggregatesByScopeAndRange,
  filterSessionsByScopeAndRange
} from './scope-range-filter'
import {
  buildOpenCodeUsageBreakdownRows,
  buildOpenCodeUsageDailyPoints,
  buildOpenCodeUsageRecentSessions,
  buildOpenCodeUsageSummary
} from './snapshot-rollups'
import { UsageProviderStoreLifecycle } from '../usage/provider-lifecycle/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'

export class OpenCodeUsageStore extends UsageProviderStoreLifecycle<
  'processedDatabases',
  OpenCodeUsagePersistedState,
  'hasAnyOpenCodeData'
> {
  constructor(host: UsageStoreHost) {
    super(host, {
      tokenUsage: {
        provider: 'opencode',
        selectSessions: (state) => codexOpenCodeTokenSessions(state.sessions)
      },
      logTag: '[opencode-usage]',
      resolveCacheFile: () => join(host.userDataPath, 'orca-opencode-usage.json'),
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedDatabases',
      dataPresenceKey: 'hasAnyOpenCodeData',
      scan: async (worktrees, sourceCache) => {
        const accountRoots = await host.accountRoots?.('opencode')
        host.signal.throwIfAborted()
        return openCodeUsageProvider.scan(worktrees, sourceCache, accountRoots)
      },
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    recentSessionLimit = 10,
    includeHistory = false
  ): OpenCodeUsageSnapshot {
    return {
      scanState: this.getScanState(),
      ...(includeHistory
        ? {
            historyToday: localUsageDay(new Date()),
            history: projectEventUsageHistory('opencode', this.getFilteredDaily(scope, range))
          }
        : {}),
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
    return buildOpenCodeUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
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
    return buildOpenCodeUsageDailyPoints(this.getFilteredDaily(scope, range))
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
    return buildOpenCodeUsageBreakdownRows(
      kind,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
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
    return buildOpenCodeUsageRecentSessions(
      this.getFilteredSessions(scope, range),
      limit,
      this.getFilteredDaily(scope, range),
      range
    )
  }

  private getFilteredDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageDailyAggregate[] {
    return filterDailyAggregatesByScopeAndRange(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageSession[] {
    return filterSessionsByScopeAndRange(this.state.sessions, scope, range)
  }
}
