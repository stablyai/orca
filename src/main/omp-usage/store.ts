import { app } from 'electron'
import { join } from 'node:path'
import type {
  OmpUsageBreakdownKind,
  OmpUsageBreakdownRow,
  OmpUsageDailyPoint,
  OmpUsageRange,
  OmpUsageScope,
  OmpUsageSessionRow,
  OmpUsageSnapshot,
  OmpUsageSummary
} from '../../shared/omp-usage-types'
import type { Store } from '../persistence'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/usage-scan-worker-spawn'
import { scanOmpUsageFiles } from './scanner'
import {
  buildOmpUsageBreakdownRows,
  buildOmpUsageDailyPoints,
  buildOmpUsageRecentSessions,
  buildOmpUsageSummary,
  filterOmpUsageDaily,
  filterOmpUsageSessions
} from './snapshot-rollups'
import type { OmpUsagePersistedState, OmpUsageSession } from './types'

export const OMP_USAGE_SCHEMA_VERSION = 1

let ompUsageFile: string | null = null

export function initOmpUsagePath(): void {
  ompUsageFile = join(app.getPath('userData'), 'orca-omp-usage.json')
}

function getOmpUsageFile(): string {
  ompUsageFile ??= join(app.getPath('userData'), 'orca-omp-usage.json')
  return ompUsageFile
}

export function getDefaultOmpUsageState(): OmpUsagePersistedState {
  return {
    schemaVersion: OMP_USAGE_SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
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

export function normalizePersistedState(state: OmpUsagePersistedState): OmpUsagePersistedState {
  if (state.schemaVersion !== OMP_USAGE_SCHEMA_VERSION) {
    // Rebuild incompatible projections while preserving the user's tracking preference.
    const defaults = getDefaultOmpUsageState()
    return {
      ...defaults,
      scanState: {
        ...defaults.scanState,
        enabled: state.scanState?.enabled ?? defaults.scanState.enabled
      }
    }
  }
  return state
}

export class OmpUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  OmpUsagePersistedState,
  'hasAnyOmpData'
> {
  readonly id = 'omp' as const
  readonly label = 'omp' as const

  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[omp-usage]',
      resolveCacheFile: getOmpUsageFile,
      createDefaultState: getDefaultOmpUsageState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyOmpData',
      scan: scanOmpUsageFiles,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: OmpUsageScope,
    range: OmpUsageRange,
    recentSessionLimit = 10
  ): OmpUsageSnapshot {
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildOmpUsageSummary(scope, range, sessions),
      daily: buildOmpUsageDailyPoints(this.getFilteredDaily(range)),
      modelBreakdown: buildOmpUsageBreakdownRows('model', sessions),
      projectBreakdown: buildOmpUsageBreakdownRows('project', sessions),
      recentSessions: buildOmpUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(scope: OmpUsageScope, range: OmpUsageRange): Promise<OmpUsageSummary> {
    await this.refresh(false)
    return buildOmpUsageSummary(scope, range, this.getFilteredSessions(scope, range))
  }

  async getDaily(_scope: OmpUsageScope, range: OmpUsageRange): Promise<OmpUsageDailyPoint[]> {
    await this.refresh(false)
    // Stored omp daily aggregates carry no worktree attribution, so only the range narrows them.
    return buildOmpUsageDailyPoints(this.getFilteredDaily(range))
  }

  async getBreakdown(
    scope: OmpUsageScope,
    range: OmpUsageRange,
    kind: OmpUsageBreakdownKind
  ): Promise<OmpUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildOmpUsageBreakdownRows(kind, this.getFilteredSessions(scope, range))
  }

  async getRecentSessions(
    scope: OmpUsageScope,
    range: OmpUsageRange,
    limit = 10
  ): Promise<OmpUsageSessionRow[]> {
    await this.refresh(false)
    return buildOmpUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private getFilteredDaily(range: OmpUsageRange) {
    return filterOmpUsageDaily(this.state.dailyAggregates, range)
  }

  private getFilteredSessions(scope: OmpUsageScope, range: OmpUsageRange): OmpUsageSession[] {
    return filterOmpUsageSessions(this.state.sessions, scope, range)
  }
}
