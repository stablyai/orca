import { claudeTokenSessions } from '../usage/agent-token-usage'
import { app } from 'electron'
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
import type { ClaudeUsagePersistedState, ClaudeUsageSshHostSnapshot } from './types'
import { scanClaudeUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { buildBreakdown, buildDaily, buildSummary } from './claude-usage-report-aggregation'
import { buildRecentSessions } from './claude-usage-session-rows'
import type { AutomationUsageLookupInput } from './claude-usage-automation-attribution'
import { resolveAutomationRunUsage } from './claude-usage-automation-attribution'
import { CLAUDE_USAGE_SCHEMA_VERSION } from './claude-usage-schema-version'
import { loadKnownSshUsageWorktreesByTarget } from '../usage-worktree-metadata'
import {
  mergeClaudeUsageWithSshHosts,
  scanClaudeUsageOnSshHosts,
  type ClaudeUsageSshTransport
} from './ssh-host-usage-scan'

const SCHEMA_VERSION = CLAUDE_USAGE_SCHEMA_VERSION

// Why: capture the path after configureDevUserDataPath() but before app.setName()
// mutates Electron's derived userData location, matching the persistence/store pattern.
let _claudeUsageFile: string | null = null

function getDefaultState(): ClaudeUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    sshHosts: {},
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

function normalizePersistedState(state: ClaudeUsagePersistedState): ClaudeUsagePersistedState {
  if (state.schemaVersion === SCHEMA_VERSION) {
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

export function initClaudeUsagePath(): void {
  _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json')
}

function getClaudeUsageFile(): string {
  if (!_claudeUsageFile) {
    _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json')
  }
  return _claudeUsageFile
}

export class ClaudeUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  ClaudeUsagePersistedState,
  'hasAnyClaudeData'
> {
  constructor(
    store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
    options: { sshTransport?: ClaudeUsageSshTransport } = {}
  ) {
    const { sshTransport } = options
    // Why late-bound: `this.state` does not exist until super() returns.
    let readSshHosts = (): Record<string, ClaudeUsageSshHostSnapshot> => ({})
    super(store, {
      tokenUsage: {
        provider: 'claude',
        selectSessions: (state) => claudeTokenSessions(state.sessions)
      },
      logTag: '[claude-usage]',
      resolveCacheFile: getClaudeUsageFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyClaudeData',
      jsonIndent: 2,
      scan: async (worktrees, previous) => {
        if (!sshTransport) {
          return scanClaudeUsageFilesViaWorker(worktrees, previous)
        }
        // Why in parallel: remote hosts scan their own transcripts, so the
        // local worker and each relay sidecar do independent work.
        const [local, sshHosts] = await Promise.all([
          scanClaudeUsageFilesViaWorker(worktrees, previous),
          scanClaudeUsageOnSshHosts({
            transport: sshTransport,
            worktreesByTarget: loadKnownSshUsageWorktreesByTarget(store, store.getRepos()),
            previous: readSshHosts(),
            onHostError: (targetId, error) =>
              console.warn(`[claude-usage] SSH host ${targetId} scan failed:`, error)
          })
        ])
        return { ...local, ...mergeClaudeUsageWithSshHosts(local, sshHosts), sshHosts }
      }
    })
    readSshHosts = () => this.state.sshHosts ?? {}
  }

  getSnapshot(
    scope: ClaudeUsageScope,
    range: ClaudeUsageRange,
    recentSessionLimit = 10
  ): ClaudeUsageSnapshot {
    return {
      scanState: this.getScanState(),
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
    return resolveAutomationRunUsage(input, {
      getState: () => this.state,
      refresh: (force) => this.refresh(force),
      isScanning: () => this.getScanState().isScanning
    })
  }
}
