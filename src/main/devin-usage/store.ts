import { app } from 'electron'
import { join } from 'node:path'
import type {
  DevinUsageBreakdownKind,
  DevinUsageBreakdownRow,
  DevinUsageDailyPoint,
  DevinUsageRange,
  DevinUsageScope,
  DevinUsageSessionRow,
  DevinUsageSnapshot,
  DevinUsageSummary
} from '../../shared/devin-usage-types'
import type { Store } from '../persistence'
import type { DevinUsageDailyAggregate, DevinUsagePersistedState, DevinUsageSession } from './types'
import { devinUsageProvider } from './devin-usage-provider'
import { getDefaultState, normalizePersistedState } from './persisted-state-normalization'
import {
  filterDailyAggregatesByScopeAndRange,
  filterSessionsByScopeAndRange
} from './scope-range-filter'
import {
  buildDevinUsageBreakdownRows,
  buildDevinUsageDailyPoints,
  buildDevinUsageRecentSessions,
  buildDevinUsageSummary
} from './snapshot-rollups'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'

let _devinUsageFile: string | null = null

export function initDevinUsagePath(): void {
  _devinUsageFile = join(app.getPath('userData'), 'orca-devin-usage.json')
}

function getDevinUsageFile(): string {
  if (!_devinUsageFile) {
    _devinUsageFile = join(app.getPath('userData'), 'orca-devin-usage.json')
  }
  return _devinUsageFile
}

export class DevinUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  DevinUsagePersistedState,
  'hasAnyDevinData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[devin-usage]',
      resolveCacheFile: getDevinUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyDevinData',
      jsonIndent: 2,
      scan: devinUsageProvider.scan
    })
  }

  getSnapshot(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    recentSessionLimit = 10
  ): DevinUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: this.buildSummary(scope, range),
      daily: this.buildDaily(scope, range),
      modelBreakdown: this.buildBreakdown(scope, range, 'model'),
      projectBreakdown: this.buildBreakdown(scope, range, 'project'),
      recentSessions: this.buildRecentSessions(scope, range, recentSessionLimit)
    }
  }

  async getSummary(scope: DevinUsageScope, range: DevinUsageRange): Promise<DevinUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  private buildSummary(scope: DevinUsageScope, range: DevinUsageRange): DevinUsageSummary {
    return buildDevinUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  async getDaily(scope: DevinUsageScope, range: DevinUsageRange): Promise<DevinUsageDailyPoint[]> {
    await this.refresh(false)
    return this.buildDaily(scope, range)
  }

  private buildDaily(scope: DevinUsageScope, range: DevinUsageRange): DevinUsageDailyPoint[] {
    return buildDevinUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    kind: DevinUsageBreakdownKind
  ): Promise<DevinUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  private buildBreakdown(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    kind: DevinUsageBreakdownKind
  ): DevinUsageBreakdownRow[] {
    return buildDevinUsageBreakdownRows(
      kind,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range),
      scope
    )
  }

  async getRecentSessions(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    limit = 10
  ): Promise<DevinUsageSessionRow[]> {
    await this.refresh(false)
    return this.buildRecentSessions(scope, range, limit)
  }

  private buildRecentSessions(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    limit = 10
  ): DevinUsageSessionRow[] {
    return buildDevinUsageRecentSessions(this.getFilteredSessions(scope, range), scope, limit)
  }

  private getFilteredDaily(
    scope: DevinUsageScope,
    range: DevinUsageRange
  ): DevinUsageDailyAggregate[] {
    return filterDailyAggregatesByScopeAndRange(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(scope: DevinUsageScope, range: DevinUsageRange): DevinUsageSession[] {
    return filterSessionsByScopeAndRange(this.state.sessions, scope, range)
  }
}
