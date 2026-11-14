import { join } from 'node:path'
import type {
  MistralVibeUsageBreakdownKind,
  MistralVibeUsageBreakdownRow,
  MistralVibeUsageDailyPoint,
  MistralVibeUsageRange,
  MistralVibeUsageScope,
  MistralVibeUsageSessionRow,
  MistralVibeUsageSnapshot,
  MistralVibeUsageSummary
} from '../../shared/mistral-vibe-usage-types'
import type { UsageStoreHost } from '../usage/usage-store-host'
import { UsageProviderStoreLifecycle } from '../usage/provider-lifecycle/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import {
  filterUsageDaily,
  filterUsageSessions
} from '../usage/reporting/range-query/usage-scope-filters'
import { mistralVibeUsageProvider } from './mistral-vibe-usage-provider'
import {
  getDefaultMistralVibeUsageState,
  normalizeMistralVibeUsageState
} from './persisted-state-normalization'
import {
  buildMistralVibeUsageBreakdownRows,
  buildMistralVibeUsageDailyPoints,
  buildMistralVibeUsageRecentSessions,
  buildMistralVibeUsageSummary
} from './snapshot-rollups'
import type {
  MistralVibeUsageDailyAggregate,
  MistralVibeUsagePersistedState,
  MistralVibeUsageSession
} from './types'

export class MistralVibeUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  MistralVibeUsagePersistedState,
  'hasAnyMistralVibeData'
> {
  constructor(host: UsageStoreHost) {
    super(host, {
      logTag: '[mistral-vibe-usage]',
      resolveCacheFile: () => join(host.userDataPath, 'orca-mistral-vibe-usage.json'),
      createDefaultState: getDefaultMistralVibeUsageState,
      normalizeState: normalizeMistralVibeUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyMistralVibeData',
      scan: mistralVibeUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange,
    recentSessionLimit = 10
  ): MistralVibeUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildMistralVibeUsageSummary(scope, range, daily, sessions),
      daily: buildMistralVibeUsageDailyPoints(daily),
      modelBreakdown: buildMistralVibeUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildMistralVibeUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildMistralVibeUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange
  ): Promise<MistralVibeUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange
  ): Promise<MistralVibeUsageDailyPoint[]> {
    await this.refresh(false)
    return buildMistralVibeUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange,
    kind: MistralVibeUsageBreakdownKind
  ): Promise<MistralVibeUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange,
    limit = 10
  ): Promise<MistralVibeUsageSessionRow[]> {
    await this.refresh(false)
    return buildMistralVibeUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange
  ): MistralVibeUsageSummary {
    return buildMistralVibeUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange,
    kind: MistralVibeUsageBreakdownKind
  ): MistralVibeUsageBreakdownRow[] {
    return buildMistralVibeUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange
  ): MistralVibeUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(
    scope: MistralVibeUsageScope,
    range: MistralVibeUsageRange
  ): MistralVibeUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
