import { localUsageDay } from '../../shared/usage-history-range'
import { filterUsageDaily } from '../usage/usage-scope-filters'
import { projectClaudeUsageHistory } from '../usage/usage-history-projection'
import { claudeTokenSessions } from '../usage/agent-token-usage'
import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSessionRow,
  ClaudeUsageSnapshot,
  ClaudeUsageSummary
} from '../../shared/claude-usage-types'
import type { AutomationRunUsage } from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { ClaudeUsagePersistedState } from './types'
import {
  scanClaudeUsageFilesViaWorker,
  splitUsageCacheFileViaWorker
} from '../usage/usage-scan-worker-spawn'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { buildBreakdown, buildDaily, buildSummary } from './claude-usage-report-aggregation'
import { buildRecentSessions } from './claude-usage-session-rows'
import type { AutomationUsageLookupInput } from './claude-usage-automation-attribution'
import { resolveAutomationRunUsage } from './claude-usage-automation-attribution'
import { parseClaudeUsageReport, serializeClaudeUsageReport } from './persisted-usage-report'

// Pre-v6 totals lack stable fork ownership or the 1-hour cache-write split and must be rescanned.
// v7 stores protected column checkpoints on the worker and a separately protected report.
const SCHEMA_VERSION = 7

// Capture after configureDevUserDataPath(), before app.setName() changes the derived userData path.
let _claudeUsageFile: string | null = null

function getDefaultState(): ClaudeUsagePersistedState {
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

function normalizePersistedState(state: ClaudeUsagePersistedState): ClaudeUsagePersistedState {
  if (state.schemaVersion === 6 || state.schemaVersion === SCHEMA_VERSION) {
    return state
  }
  // Scanner changes invalidate totals, but preserving enabled keeps existing tracking on.
  const defaults = getDefaultState()
  return {
    ...defaults,
    scanState: {
      ...defaults.scanState,
      enabled: state.scanState.enabled ?? defaults.scanState.enabled
    }
  }
}

export function initClaudeUsagePath(userDataPath = getAppEnvironment().getPath('userData')): void {
  _claudeUsageFile = join(userDataPath, 'orca-claude-usage.json')
}

function getClaudeUsageFile(): string {
  if (!_claudeUsageFile) {
    _claudeUsageFile = join(getAppEnvironment().getPath('userData'), 'orca-claude-usage.json')
  }
  return _claudeUsageFile
}

export class ClaudeUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  ClaudeUsagePersistedState,
  'hasAnyClaudeData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      tokenUsage: {
        provider: 'claude',
        selectSessions: (state) => claudeTokenSessions(state.sessions)
      },
      logTag: '[claude-usage]',
      resolveCacheFile: getClaudeUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      parseReport: parseClaudeUsageReport,
      serializeReport: serializeClaudeUsageReport,
      providerId: 'claude',
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyClaudeData',
      scan: scanClaudeUsageFilesViaWorker,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    recentSessionLimit = 10,
    includeHistory = false
  ): ClaudeUsageSnapshot {
    return {
      scanState: this.getScanState(),
      ...(includeHistory
        ? {
            historyToday: localUsageDay(new Date()),
            historyNeedsRescan: this.state.schemaVersion === 6,
            history: projectClaudeUsageHistory(
              filterUsageDaily(this.state.dailyAggregates, scope, range)
            )
          }
        : {}),
      summary: buildSummary(this.state, scope, range),
      daily: buildDaily(this.state, scope, range),
      modelBreakdown: buildBreakdown(this.state, scope, range, 'model'),
      projectBreakdown: buildBreakdown(this.state, scope, range, 'project'),
      recentSessions: buildRecentSessions(this.state, scope, range, recentSessionLimit)
    }
  }

  async getSummary(scope: ClaudeUsageScope, range: ClaudeUsageRange): Promise<ClaudeUsageSummary> {
    await this.refresh(false)
    return buildSummary(this.state, scope, range)
  }

  async getDaily(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange
  ): Promise<ClaudeUsageDailyPoint[]> {
    await this.refresh(false)
    return buildDaily(this.state, scope, range)
  }

  async getBreakdown(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    kind: ClaudeUsageBreakdownKind
  ): Promise<ClaudeUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildBreakdown(this.state, scope, range, kind)
  }

  async getRecentSessions(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    limit = 12
  ): Promise<ClaudeUsageSessionRow[]> {
    await this.refresh(false)
    return buildRecentSessions(this.state, scope, range, limit)
  }

  async getAutomationRunUsage(input: AutomationUsageLookupInput): Promise<AutomationRunUsage> {
    await this.whenLoaded()
    return resolveAutomationRunUsage(input, {
      getState: () => this.state,
      refresh: (force) => this.refresh(force),
      isScanning: () => this.getScanState().isScanning
    })
  }
}
