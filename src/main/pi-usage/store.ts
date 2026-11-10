import { app } from 'electron'
import { join } from 'node:path'
import type {
  PiUsageBreakdownKind,
  PiUsageBreakdownRow,
  PiUsageDailyPoint,
  PiUsageRange,
  PiUsageScope,
  PiUsageSessionRow,
  PiUsageSnapshot,
  PiUsageSummary
} from '../../shared/pi-usage-types'
import type { Store } from '../persistence/loading-store/store'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/usage-scan-worker-spawn'
import { filterUsageDaily, filterUsageSessions } from '../usage/usage-scope-filters'
import { piUsageProvider } from './pi-usage-provider'
import { getDefaultPiUsageState, normalizePiUsageState } from './persisted-state-normalization'
import {
  buildPiUsageBreakdownRows,
  buildPiUsageDailyPoints,
  buildPiUsageRecentSessions,
  buildPiUsageSummary
} from './snapshot-rollups'
import type { PiUsageDailyAggregate, PiUsagePersistedState, PiUsageSession } from './types'

let piUsageFile: string | null = null

export function initPiUsagePath(): void {
  piUsageFile = join(app.getPath('userData'), 'orca-pi-usage.json')
}

function getPiUsageFile(): string {
  piUsageFile ??= join(app.getPath('userData'), 'orca-pi-usage.json')
  return piUsageFile
}

export class PiUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  PiUsagePersistedState,
  'hasAnyPiData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[pi-usage]',
      resolveCacheFile: getPiUsageFile,
      createDefaultState: getDefaultPiUsageState,
      normalizeState: normalizePiUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyPiData',
      scan: piUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(scope: PiUsageScope, range: PiUsageRange, recentSessionLimit = 10): PiUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildPiUsageSummary(scope, range, daily, sessions),
      daily: buildPiUsageDailyPoints(daily),
      modelBreakdown: buildPiUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildPiUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildPiUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(scope: PiUsageScope, range: PiUsageRange): Promise<PiUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(scope: PiUsageScope, range: PiUsageRange): Promise<PiUsageDailyPoint[]> {
    await this.refresh(false)
    return buildPiUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: PiUsageScope,
    range: PiUsageRange,
    kind: PiUsageBreakdownKind
  ): Promise<PiUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: PiUsageScope,
    range: PiUsageRange,
    limit = 10
  ): Promise<PiUsageSessionRow[]> {
    await this.refresh(false)
    return buildPiUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(scope: PiUsageScope, range: PiUsageRange): PiUsageSummary {
    return buildPiUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: PiUsageScope,
    range: PiUsageRange,
    kind: PiUsageBreakdownKind
  ): PiUsageBreakdownRow[] {
    return buildPiUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(scope: PiUsageScope, range: PiUsageRange): PiUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(scope: PiUsageScope, range: PiUsageRange): PiUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
