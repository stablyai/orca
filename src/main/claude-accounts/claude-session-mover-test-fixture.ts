import type { AgentHookServer } from '../agent-hooks/server'
import { vi } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type {
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry
} from '../agent-hooks/server/server-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence/persistence-session-fixtures'
import type { ClaudePaneAccountRecord } from './claude-pane-account-registry'
import type {
  ClaudeSessionMoveOutcome,
  ClaudeSessionMoveRequest,
  ClaudeSessionMoveStrategy
} from './claude-session-move-strategy'
import { createClaudeSessionMover, type ClaudeSessionMoveNotice } from './claude-session-mover'

const HOST = { runtime: 'host' as const, wslDistro: null }
export const PANE_1 = makePaneKey('tab-1', TEST_LEAF_1)
export const PANE_2 = makePaneKey('tab-1', TEST_LEAF_2)

export function account(
  id: string,
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...overrides
  }
}

export function limits(usedPercent: number, updatedAt = Date.now()): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

/** Selected account `a` on the bar; the others as inactive entries. */
export function state(
  active: number,
  inactive: Record<string, ProviderRateLimits>
): RateLimitState {
  return createEmptyRateLimitState({
    claude: { ...limits(active), usageMetadata: { authProvenance: 'profile:a' } },
    claudeTarget: HOST,
    inactiveClaudeAccounts: Object.entries(inactive).map(([accountId, rateLimits]) => ({
      accountId,
      rateLimits,
      updatedAt: rateLimits.updatedAt,
      isFetching: false
    }))
  })
}

function record(
  ptyId: string,
  paneKey: string,
  accountId: string,
  pinned = false
): ClaudePaneAccountRecord {
  return {
    ptyId,
    paneKey,
    accountId,
    configDir: `/profiles/${accountId}/home`,
    launchedAt: 0,
    pinned,
    source: pinned ? 'transcript' : 'spawn'
  }
}

export function setup(
  options: {
    setting?: 'off' | 'ask' | 'move'
    /** Tests pass the pool field directly. The production default is off. */
    pool?: 'off' | 'on'
    headless?: boolean
    accounts?: ClaudeManagedAccountSummary[]
    getStatusSnapshotForPane?: AgentHookServer['getStatusSnapshotForPane']
    /** When set, `move` delegates here and leaves the registry record on the old PTY. */
    strategy?: ClaudeSessionMoveStrategy
    proxyStrategy?: ClaudeSessionMoveStrategy
  } = {}
) {
  const settings = {
    claudeSessionMover: options.setting ?? ('move' as const),
    claudeAccountPool: options.pool ?? ('off' as const),
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    claudeManagedAccounts: (options.accounts ?? [account('a'), account('b'), account('c')]).map(
      (entry) => ({ ...entry, managedAuthPath: `/profiles/${entry.id}/home` })
    )
  }
  const accounts = options.accounts ?? [account('a'), account('b'), account('c')]
  let current = state(30, { b: limits(96), c: limits(20) })
  const records: ClaudePaneAccountRecord[] = []
  let statuses: AgentHookStatusChangeEntry[] = []
  let providerSessions: AgentHookProviderSessionIdentity[] = []
  const stateListeners = new Set<(next: RateLimitState) => void>()
  const statusListeners = new Set<() => void>()
  const fetchInactive = vi.fn(async () => {})
  const nonAgentTask = new Map<string, boolean>()
  const move = vi.fn<(request: ClaudeSessionMoveRequest) => Promise<ClaudeSessionMoveOutcome>>(
    async (request) => {
      if (options.strategy) {
        return options.strategy.move(request)
      }
      const newPtyId = request.ptyId === 'pty-1' ? 'pty-new' : `${request.ptyId}-new`
      const index = records.findIndex((entry) => entry.ptyId === request.ptyId)
      const previous = records[index]
      if (previous) {
        records.splice(index, 1, {
          ...previous,
          ptyId: newPtyId,
          accountId: request.toAccountId,
          configDir: `/profiles/${request.toAccountId}/home`,
          pinned: false,
          source: 'spawn',
          launchedAt: Date.now()
        })
      }
      return { kind: 'moved', newPtyId }
    }
  )
  const notices: ClaudeSessionMoveNotice[] = []
  const log = vi.fn()
  const mover = createClaudeSessionMover({
    getSettings: () => settings,
    rateLimits: {
      onStateChange: (listener) => {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      },
      getState: () => current,
      fetchInactiveClaudeAccountsOnOpen: fetchInactive
    },
    accounts: { listAccounts: () => ({ accounts, activeAccountId: 'a' }) },
    hooks: {
      subscribeStatusChanges: (listener) => {
        const notify = () => listener(statuses)
        statusListeners.add(notify)
        return () => {
          statusListeners.delete(notify)
        }
      },
      getStatusSnapshotForPane: options.getStatusSnapshotForPane ?? (() => []),
      getStatusChangeSnapshot: () => statuses,
      getProviderSessionIdentities: () => providerSessions,
      getClaudeRunningNonAgentTask: (paneKey) => nonAgentTask.get(paneKey)
    },
    registry: {
      list: () => [...records],
      record: (entry) => {
        records.push(entry)
      }
    },
    resolvePaneKey: (ptyId) => records.find((entry) => entry.ptyId === ptyId)?.paneKey ?? null,
    resolvePtyIdForPaneKey: (paneKey) => (paneKey === PANE_2 ? 'pty-2' : null),
    resolveWorktreeId: () => 'repo-local::/fixture',
    accountHomes: (accountId) => [`/profiles/${accountId}/home`],
    strategy: { move },
    ...(options.proxyStrategy ? { proxyStrategy: options.proxyStrategy } : {}),
    headless: options.headless ?? false,
    onNotice: (notice) => notices.push(notice),
    log
  })
  const publish = (next: RateLimitState) => {
    current = next
    for (const listener of stateListeners) {
      listener(next)
    }
  }
  const session = (
    ptyId: string,
    paneKey: string,
    accountId: string,
    paneState: AgentHookStatusChangeEntry['state'] = 'done',
    pinned = false,
    mainAgentState?: AgentHookStatusChangeEntry['mainAgentState'],
    backgroundWork = false,
    turnEndedAt?: number
  ) => {
    records.push(record(ptyId, paneKey, accountId, pinned))
    statuses = [
      ...statuses,
      {
        paneKey,
        state: paneState,
        ...(mainAgentState ? { mainAgentState } : {}),
        ...(backgroundWork ? { backgroundWork: true } : {}),
        ...(turnEndedAt !== undefined ? { turnEndedAt } : {}),
        receivedAt: Date.now(),
        observedInCurrentRuntime: true
      }
    ]
    providerSessions = [
      ...providerSessions,
      {
        paneKey,
        sessionId: `sess-${ptyId}`,
        transcriptPath: `/profiles/${accountId}/home/projects/x/sess-${ptyId}.jsonl`,
        worktreeId: 'repo-local::/fixture'
      }
    ]
  }
  const setStatus = (paneKey: string, paneState: AgentHookStatusChangeEntry['state']) => {
    statuses = statuses.map((entry) =>
      entry.paneKey === paneKey ? { ...entry, state: paneState } : entry
    )
    for (const listener of statusListeners) {
      listener()
    }
  }
  const setBackgroundWork = (paneKey: string, alive: boolean, notify = true) => {
    statuses = statuses.map((entry) => {
      if (entry.paneKey !== paneKey) {
        return entry
      }
      if (alive) {
        return { ...entry, backgroundWork: true }
      }
      const next = { ...entry }
      delete next.backgroundWork
      return next
    })
    if (!notify) {
      return
    }
    for (const listener of statusListeners) {
      listener()
    }
  }
  return {
    mover,
    settings,
    publish,
    session,
    setStatus,
    setBackgroundWork,
    move,
    fetchInactive,
    notices,
    log,
    records,
    setProviderSessions: (next: AgentHookProviderSessionIdentity[]) => {
      providerSessions = next
    },
    setNonAgentTask: (paneKey: string, running: boolean | undefined) => {
      if (running === undefined) {
        nonAgentTask.delete(paneKey)
        return
      }
      nonAgentTask.set(paneKey, running)
    }
  }
}
