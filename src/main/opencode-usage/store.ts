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
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'

let _openCodeUsageFile: string | null = null

export function initOpenCodeUsagePath(): void {
  _openCodeUsageFile = join(app.getPath('userData'), 'orca-opencode-usage.json')
}

function getOpenCodeUsageFile(): string {
  if (!_openCodeUsageFile) {
    _openCodeUsageFile = join(app.getPath('userData'), 'orca-opencode-usage.json')
  }
  return _openCodeUsageFile
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
    return buildOpenCodeUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
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
