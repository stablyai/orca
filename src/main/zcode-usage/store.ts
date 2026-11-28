import { join } from 'node:path'
import type {
  ZcodeUsageBreakdownKind,
  ZcodeUsageBreakdownRow,
  ZcodeUsageDailyPoint,
  ZcodeUsageRange,
  ZcodeUsageScope,
  ZcodeUsageSessionRow,
  ZcodeUsageSnapshot,
  ZcodeUsageSummary
} from '../../shared/zcode-usage-types'
import type { UsageStoreHost } from '../usage/usage-store-host'
import { UsageProviderStoreLifecycle } from '../usage/provider-lifecycle/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import {
  filterUsageDaily,
  filterUsageSessions
} from '../usage/reporting/range-query/usage-scope-filters'
import { zcodeUsageProvider } from './zcode-usage-provider'
import {
  getDefaultZcodeUsageState,
  normalizeZcodeUsageState
} from './persisted-state-normalization'
import {
  buildZcodeUsageBreakdownRows,
  buildZcodeUsageDailyPoints,
  buildZcodeUsageRecentSessions,
  buildZcodeUsageSummary
} from './snapshot-rollups'
import type { ZcodeUsageDailyAggregate, ZcodeUsagePersistedState, ZcodeUsageSession } from './types'

export class ZcodeUsageStore extends UsageProviderStoreLifecycle<
  'processedDatabases',
  ZcodeUsagePersistedState,
  'hasAnyZcodeData'
> {
  constructor(host: UsageStoreHost) {
    super(host, {
      logTag: '[zcode-usage]',
      resolveCacheFile: () => join(host.userDataPath, 'orca-zcode-usage.json'),
      createDefaultState: getDefaultZcodeUsageState,
      normalizeState: normalizeZcodeUsageState,
      sourceKey: 'processedDatabases',
      dataPresenceKey: 'hasAnyZcodeData',
      scan: zcodeUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: ZcodeUsageScope,
    range: ZcodeUsageRange,
    recentSessionLimit = 10
  ): ZcodeUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildZcodeUsageSummary(scope, range, daily, sessions),
      daily: buildZcodeUsageDailyPoints(daily),
      modelBreakdown: buildZcodeUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildZcodeUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildZcodeUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(scope: ZcodeUsageScope, range: ZcodeUsageRange): Promise<ZcodeUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(scope: ZcodeUsageScope, range: ZcodeUsageRange): Promise<ZcodeUsageDailyPoint[]> {
    await this.refresh(false)
    return buildZcodeUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: ZcodeUsageScope,
    range: ZcodeUsageRange,
    kind: ZcodeUsageBreakdownKind
  ): Promise<ZcodeUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: ZcodeUsageScope,
    range: ZcodeUsageRange,
    limit = 10
  ): Promise<ZcodeUsageSessionRow[]> {
    await this.refresh(false)
    return buildZcodeUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(scope: ZcodeUsageScope, range: ZcodeUsageRange): ZcodeUsageSummary {
    return buildZcodeUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: ZcodeUsageScope,
    range: ZcodeUsageRange,
    kind: ZcodeUsageBreakdownKind
  ): ZcodeUsageBreakdownRow[] {
    return buildZcodeUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: ZcodeUsageScope,
    range: ZcodeUsageRange
  ): ZcodeUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(scope: ZcodeUsageScope, range: ZcodeUsageRange): ZcodeUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
