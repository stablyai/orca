import type { AgentProviderSessionMetadata } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusState } from '../../shared/agent-status/contracts/agent-status-types'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { InactiveAccountUsage, RateLimitState } from '../../shared/rate-limit-types'
import type {
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry
} from '../agent-hooks/server/server-types'
import { claudeAccountsShareRuntime, isClaudeUsageReadingOf } from './claude-account-auto-switch'
import {
  inferClaudeAccountIdFromTranscript,
  type ClaudeAccountHomes,
  type ClaudePaneAccountRecord
} from './claude-pane-account-registry'

export type ClaudeMoverSessionView = {
  record: ClaudePaneAccountRecord
  paneKey: string | null
  paneState: AgentStatusState | null
  /** True when a shell, cron, or monitor is still alive on this pane. */
  paneBackgroundWork: boolean
  /** When this pane's last turn ended, if the hook status published one. */
  turnEndedAt?: number
  providerSession: AgentProviderSessionMetadata | null
  worktreeId: string | null
}

/** Combined pane state folds in live children. The mover follows the main agent when one was published. */
function moverPaneState(entry: AgentHookStatusChangeEntry | undefined): AgentStatusState | null {
  if (!entry) {
    return null
  }
  return entry.mainAgentState ?? entry.state
}

function moverPaneBackgroundWork(entry: AgentHookStatusChangeEntry | undefined): boolean {
  return entry?.backgroundWork === true
}

/**
 * Every live Claude session the mover may act on: the registry's records, plus sessions Orca did not
 * route (a shell's own CLAUDE_CONFIG_DIR) learned from their transcript path and recorded as pinned.
 */
export function collectClaudeMoverSessions(args: {
  records: ClaudePaneAccountRecord[]
  statuses: AgentHookStatusChangeEntry[]
  providerSessions: AgentHookProviderSessionIdentity[]
  resolveProviderSession: (
    paneKey: string,
    sessionId: string
  ) => AgentProviderSessionMetadata | null
  resolvePaneKey: (ptyId: string) => string | null
  resolvePtyIdForPaneKey: (paneKey: string) => string | null
  resolveWorktreeId: (ptyId: string) => string | null
  accounts: readonly ClaudeAccountHomes[]
  recordInferred: (record: ClaudePaneAccountRecord) => void
  now: number
}): ClaudeMoverSessionView[] {
  const statusByPane = new Map(args.statuses.map((entry) => [entry.paneKey, entry]))
  const identityByPane = new Map(
    args.providerSessions.map((identity) => [identity.paneKey, identity])
  )
  const known = new Map(args.records.map((record) => [record.ptyId, record]))
  for (const identity of args.providerSessions) {
    const ptyId = args.resolvePtyIdForPaneKey(identity.paneKey)
    if (!ptyId || known.has(ptyId)) {
      continue
    }
    const inferred = inferClaudeAccountIdFromTranscript(identity.transcriptPath, args.accounts)
    if (!inferred) {
      continue
    }
    const record: ClaudePaneAccountRecord = {
      ptyId,
      paneKey: identity.paneKey,
      accountId: inferred.accountId,
      configDir: inferred.configDir,
      launchedAt: args.now,
      // Why pinned: Orca never chose this folder, so the session is moved only at the limit.
      pinned: true,
      source: 'transcript'
    }
    args.recordInferred(record)
    known.set(ptyId, record)
  }
  return [...known.values()].map((record) => {
    const paneKey = record.paneKey ?? args.resolvePaneKey(record.ptyId)
    const identity = paneKey ? identityByPane.get(paneKey) : undefined
    const status = paneKey ? statusByPane.get(paneKey) : undefined
    return {
      record,
      paneKey,
      paneState: moverPaneState(status),
      paneBackgroundWork: moverPaneBackgroundWork(status),
      ...(status?.turnEndedAt !== undefined ? { turnEndedAt: status.turnEndedAt } : {}),
      providerSession: identity
        ? (args.resolveProviderSession(identity.paneKey, identity.sessionId) ?? {
            key: 'session_id',
            id: identity.sessionId,
            ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {})
          })
        : record.providerSessionId
          ? { key: 'session_id', id: record.providerSessionId }
          : null,
      worktreeId: identity?.worktreeId ?? record.worktreeId ?? args.resolveWorktreeId(record.ptyId)
    }
  })
}

/** An account's reading: the selected account's bar (if it is that account's), else its inactive entry. */
export function claudeUsageForAccount(
  state: RateLimitState,
  account: ClaudeManagedAccountSummary,
  selectedId: string | null
): InactiveAccountUsage | null {
  if (account.id === selectedId) {
    return state.claude && isClaudeUsageReadingOf(state.claude, account)
      ? {
          accountId: account.id,
          rateLimits: state.claude,
          updatedAt: state.claude.updatedAt,
          isFetching: false
        }
      : null
  }
  return state.inactiveClaudeAccounts.find((usage) => usage.accountId === account.id) ?? null
}

/** Where a session on `from` may move: the other signed-in accounts of the same runtime. */
export function claudeMoveCandidates(
  accounts: ClaudeManagedAccountSummary[],
  from: ClaudeManagedAccountSummary
): ClaudeManagedAccountSummary[] {
  return accounts.filter(
    (account) =>
      account.id !== from.id && !account.needsSignIn && claudeAccountsShareRuntime(account, from)
  )
}
