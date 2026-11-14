import { join } from 'node:path'
import type {
  MuseUsageBreakdownKind,
  MuseUsageBreakdownRow,
  MuseUsageDailyPoint,
  MuseUsageRange,
  MuseUsageScope,
  MuseUsageSessionRow,
  MuseUsageSnapshot,
  MuseUsageSummary
} from '../../shared/muse-usage-types'
import type { UsageStoreHost } from '../usage/usage-store-host'
import { UsageProviderStoreLifecycle } from '../usage/provider-lifecycle/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import {
  filterUsageDaily,
  filterUsageSessions
} from '../usage/reporting/range-query/usage-scope-filters'
import { museUsageProvider } from './muse-usage-provider'
import { getDefaultMuseUsageState, normalizeMuseUsageState } from './persisted-state-normalization'
import {
  buildMuseUsageBreakdownRows,
  buildMuseUsageDailyPoints,
  buildMuseUsageRecentSessions,
  buildMuseUsageSummary
} from './snapshot-rollups'
import type { MuseUsageDailyAggregate, MuseUsagePersistedState, MuseUsageSession } from './types'

export class MuseUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  MuseUsagePersistedState,
  'hasAnyMuseData'
> {
  constructor(host: UsageStoreHost) {
    super(host, {
      logTag: '[muse-usage]',
      resolveCacheFile: () => join(host.userDataPath, 'orca-muse-usage.json'),
      createDefaultState: getDefaultMuseUsageState,
      normalizeState: normalizeMuseUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyMuseData',
      scan: museUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    recentSessionLimit = 10
  ): MuseUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildMuseUsageSummary(scope, range, daily, sessions),
      daily: buildMuseUsageDailyPoints(daily),
      modelBreakdown: buildMuseUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildMuseUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildMuseUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(scope: MuseUsageScope, range: MuseUsageRange): Promise<MuseUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(scope: MuseUsageScope, range: MuseUsageRange): Promise<MuseUsageDailyPoint[]> {
    await this.refresh(false)
    return buildMuseUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    kind: MuseUsageBreakdownKind
  ): Promise<MuseUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    limit = 10
  ): Promise<MuseUsageSessionRow[]> {
    await this.refresh(false)
    return buildMuseUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(scope: MuseUsageScope, range: MuseUsageRange): MuseUsageSummary {
    return buildMuseUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    kind: MuseUsageBreakdownKind
  ): MuseUsageBreakdownRow[] {
    return buildMuseUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: MuseUsageScope,
    range: MuseUsageRange
  ): MuseUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(scope: MuseUsageScope, range: MuseUsageRange): MuseUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
