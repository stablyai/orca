import { app } from 'electron'
import { join } from 'node:path'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSessionRow,
  CodexUsageSnapshot,
  CodexUsageSummary
} from '../../shared/codex-usage-types'
import type { AutomationRunUsage } from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { CodexUsagePersistedState } from './types'
import type { AutomationUsageLookupInput } from './codex-automation-run-attribution'
import { CODEX_USAGE_SCHEMA_VERSION, codexUsageProvider } from './codex-usage-provider'
import { resolveCodexAutomationRunUsage } from './codex-automation-run-attribution'
import { buildRecentSessions } from './codex-usage-session-rows'
import { buildBreakdown, buildDaily, buildSummary } from './codex-usage-rollup-projections'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'

const SCHEMA_VERSION = CODEX_USAGE_SCHEMA_VERSION

let _codexUsageFile: string | null = null

function getDefaultState(): CodexUsagePersistedState {
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

export function normalizePersistedState(state: CodexUsagePersistedState): CodexUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    // Why: Orca-scoped Codex projections now depend on locationModelBreakdown.
    // Reusing an older cache would silently serve wrong model/session rows
    // until the next forced rescan, so schema changes must invalidate stale
    // persisted analytics instead of best-effort patching partial data.
    // Preserve scanState.enabled so existing users keep tracking on across
    // schema bumps; the next refresh will repopulate the analytics.
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

export function initCodexUsagePath(): void {
  _codexUsageFile = join(app.getPath('userData'), 'orca-codex-usage.json')
}

function getCodexUsageFile(): string {
  if (!_codexUsageFile) {
    _codexUsageFile = join(app.getPath('userData'), 'orca-codex-usage.json')
  }
  return _codexUsageFile
}

export class CodexUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  CodexUsagePersistedState,
  'hasAnyCodexData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[codex-usage]',
      resolveCacheFile: getCodexUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyCodexData',
      scan: codexUsageProvider.scan
    })
  }

  getSnapshot(
    scope: CodexUsageScope,
    range: CodexUsageRange,
    recentSessionLimit = 10
  ): CodexUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: buildSummary(this.state, scope, range),
      daily: buildDaily(this.state, scope, range),
      modelBreakdown: buildBreakdown(this.state, scope, range, 'model'),
      projectBreakdown: buildBreakdown(this.state, scope, range, 'project'),
      recentSessions: buildRecentSessions(this.state, scope, range, recentSessionLimit)
    }
  }

  async getSummary(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageSummary> {
    await this.refresh(false)
    return buildSummary(this.state, scope, range)
  }

  async getDaily(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageDailyPoint[]> {
    await this.refresh(false)
    return buildDaily(this.state, scope, range)
  }

  async getBreakdown(
    scope: CodexUsageScope,
    range: CodexUsageRange,
    kind: CodexUsageBreakdownKind
  ): Promise<CodexUsageBreakdownRow[]> {
    await this.refresh(false)
    return buildBreakdown(this.state, scope, range, kind)
  }

  async getRecentSessions(
    scope: CodexUsageScope,
    range: CodexUsageRange,
    limit = 12
  ): Promise<CodexUsageSessionRow[]> {
    await this.refresh(false)
    return buildRecentSessions(this.state, scope, range, limit)
  }

  async getAutomationRunUsage(input: AutomationUsageLookupInput): Promise<AutomationRunUsage> {
    return resolveCodexAutomationRunUsage(input, {
      getState: () => this.state,
      refresh: (force) => this.refresh(force)
    })
  }
}
