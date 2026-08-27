import { app } from 'electron'
import { join } from 'node:path'
import type {
  GeminiUsageBreakdownKind,
  GeminiUsageBreakdownRow,
  GeminiUsageDailyPoint,
  GeminiUsageRange,
  GeminiUsageScope,
  GeminiUsageSessionRow,
  GeminiUsageSnapshot,
  GeminiUsageSummary
} from '../../shared/gemini-usage-types'
import type { Store } from '../persistence'
import type { GeminiUsagePersistedState } from './types'
import { GEMINI_USAGE_SCHEMA_VERSION, geminiUsageProvider } from './gemini-usage-provider'
import { buildRecentSessions } from './gemini-usage-session-rows'
import { buildBreakdown, buildDaily, buildSummary } from './gemini-usage-rollup-projections'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'

const SCHEMA_VERSION = GEMINI_USAGE_SCHEMA_VERSION

let _geminiUsageFile: string | null = null

function getDefaultState(): GeminiUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
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

export function normalizePersistedState(
  state: GeminiUsagePersistedState
): GeminiUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    const defaults = getDefaultState()
    return {
      ...defaults,
      scanState: {
        ...defaults.scanState,
        enabled: state.scanState?.enabled ?? defaults.scanState.enabled
      }
    }
  }
  return {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
      locationModelBreakdown: session.locationModelBreakdown ?? []
    }))
  }
}

export function initGeminiUsagePath(): void {
  _geminiUsageFile = join(app.getPath('userData'), 'orca-gemini-usage.json')
}

function getGeminiUsageFile(): string {
  if (!_geminiUsageFile) {
    _geminiUsageFile = join(app.getPath('userData'), 'orca-gemini-usage.json')
  }
  return _geminiUsageFile
}

export class GeminiUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  GeminiUsagePersistedState,
  'hasAnyGeminiData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[gemini-usage]',
      resolveCacheFile: getGeminiUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyGeminiData',
      scan: geminiUsageProvider.scan
    })
  }

  getSnapshot(
    scope: GeminiUsageScope,
    range: GeminiUsageRange,
    recentSessionLimit = 10
  ): GeminiUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: buildSummary(this.state, scope, range),
      daily: buildDaily(this.state, scope, range),
      modelBreakdown: buildBreakdown(this.state, scope, range, 'model'),
      projectBreakdown: buildBreakdown(this.state, scope, range, 'project'),
      recentSessions: buildRecentSessions(this.state, scope, range, recentSessionLimit)
    }
  }

  async getSummary(scope: GeminiUsageScope, range: GeminiUsageRange): Promise<GeminiUsageSummary> {
    await this.refresh(false)
    return buildSummary(this.state, scope, range)
  }

  async getDaily(
    scope: GeminiUsageScope,
    range: GeminiUsageRange
  ): Promise<GeminiUsageDailyPoint[]> {
    await this.refresh(false)
    return buildDaily(this.state, scope, range)
  }

  async getBreakdown(
    scope: GeminiUsageScope,
    range: GeminiUsageRange,
    kind: GeminiUsageBreakdownKind
  ): Promise<GeminiUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildBreakdown(this.state, scope, range, kind)
  }

  async getRecentSessions(
    scope: GeminiUsageScope,
    range: GeminiUsageRange,
    limit = 12
  ): Promise<GeminiUsageSessionRow[]> {
    await this.refresh(false)
    return buildRecentSessions(this.state, scope, range, limit)
  }
}
