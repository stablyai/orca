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
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { DEVIN_USAGE_SCHEMA_VERSION, devinUsageProvider } from './devin-usage-provider'
import {
  buildDevinBreakdown,
  buildDevinDaily,
  buildDevinRecentSessions,
  buildDevinSummary
} from './devin-usage-projections'
import type { DevinUsagePersistedState } from './types'

let usageFile: string | null = null

function defaultState(): DevinUsagePersistedState {
  return {
    schemaVersion: DEVIN_USAGE_SCHEMA_VERSION,
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

export function initDevinUsagePath(): void {
  usageFile = join(app.getPath('userData'), 'orca-devin-usage.json')
}

export class DevinUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  DevinUsagePersistedState,
  'hasAnyDevinData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[devin-usage]',
      resolveCacheFile: () => usageFile ?? join(app.getPath('userData'), 'orca-devin-usage.json'),
      createDefaultState: defaultState,
      normalizeState: (state) =>
        state.schemaVersion === DEVIN_USAGE_SCHEMA_VERSION ? state : defaultState(),
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyDevinData',
      scan: devinUsageProvider.scan
    })
  }

  getSnapshot(scope: DevinUsageScope, range: DevinUsageRange, limit = 10): DevinUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: buildDevinSummary(this.state, scope, range),
      daily: buildDevinDaily(this.state, scope, range),
      modelBreakdown: buildDevinBreakdown(this.state, scope, range, 'model'),
      projectBreakdown: buildDevinBreakdown(this.state, scope, range, 'project'),
      recentSessions: buildDevinRecentSessions(this.state, scope, range, limit)
    }
  }

  async getSummary(scope: DevinUsageScope, range: DevinUsageRange): Promise<DevinUsageSummary> {
    await this.refresh(false)
    return buildDevinSummary(this.state, scope, range)
  }

  async getDaily(scope: DevinUsageScope, range: DevinUsageRange): Promise<DevinUsageDailyPoint[]> {
    await this.refresh(false)
    return buildDevinDaily(this.state, scope, range)
  }

  async getBreakdown(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    kind: DevinUsageBreakdownKind
  ): Promise<DevinUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildDevinBreakdown(this.state, scope, range, kind)
  }

  async getRecentSessions(
    scope: DevinUsageScope,
    range: DevinUsageRange,
    limit = 12
  ): Promise<DevinUsageSessionRow[]> {
    await this.refresh(false)
    return buildDevinRecentSessions(this.state, scope, range, limit)
  }
}
