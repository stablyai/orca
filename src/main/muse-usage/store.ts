import { app } from 'electron'
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
import type { Store } from '../persistence'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { filterUsageDaily, filterUsageSessions } from '../usage/usage-scope-filters'
import { museUsageProvider } from './muse-usage-provider'
import { getDefaultMuseUsageState, normalizeMuseUsageState } from './persisted-state-normalization'
import {
  buildMuseUsageBreakdownRows,
  buildMuseUsageDailyPoints,
  buildMuseUsageRecentSessions,
  buildMuseUsageSummary
} from './snapshot-rollups'
import type { MuseUsageDailyAggregate, MuseUsagePersistedState, MuseUsageSession } from './types'

let museUsageFile: string | null = null

export function initMuseUsagePath(): void {
  museUsageFile = join(app.getPath('userData'), 'orca-muse-usage.json')
}

function getMuseUsageFile(): string {
  museUsageFile ??= join(app.getPath('userData'), 'orca-muse-usage.json')
  return museUsageFile
}

export class MuseUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  MuseUsagePersistedState,
  'hasAnyMuseData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[muse-usage]',
      resolveCacheFile: getMuseUsageFile,
      createDefaultState: getDefaultMuseUsageState,
      normalizeState: normalizeMuseUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyMuseData',
      scan: museUsageProvider.scan
    })
  }

  getSnapshot(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    recentSessionLimit = 10
  ): MuseUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: this.buildSummary(scope, range),
      daily: buildMuseUsageDailyPoints(this.getFilteredDaily(scope, range)),
      modelBreakdown: this.buildBreakdown(scope, range, 'model'),
      projectBreakdown: this.buildBreakdown(scope, range, 'project'),
      recentSessions: buildMuseUsageRecentSessions(
        this.getFilteredSessions(scope, range),
        recentSessionLimit
      )
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
