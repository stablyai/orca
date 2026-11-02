import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { InactiveAccountUsage, RateLimitState } from '../../shared/rate-limit-types'
import { captureClaudeSessionMoveEndedWork } from './claude-session-move-handoff-note'
import {
  CLAUDE_SESSION_MOVE_CLAIM_DEBIT_PERCENT,
  CLAUDE_SESSION_MOVE_COOLDOWN_MS,
  claudeSessionMoveNoticeDetail,
  decideClaudeSessionMove
} from './claude-session-mover-policy'
import {
  claudeMoveCandidates,
  claudeUsageForAccount,
  type ClaudeMoverSessionView
} from './claude-session-mover-sessions'
import type { ClaudeSessionMoverDeps } from './claude-session-mover-types'
import type { ClaudeMoverHistory } from './claude-session-mover-history'

export function evaluateClaudeMoverSessions(
  deps: ClaudeSessionMoverDeps,
  history: ClaudeMoverHistory,
  views: ClaudeMoverSessionView[],
  state: RateLimitState,
  accounts: ClaudeManagedAccountSummary[],
  selectedId: string | null,
  now: number,
  effective: 'off' | 'ask' | 'move',
  lastUsageReadAt: number,
  poolEnabled: boolean
): boolean {
  const {
    lastMoveAt,
    lastFailureAt,
    lastAskAt,
    backgroundWaitAt,
    targetClaims,
    inflight,
    inflightPanes,
    remember,
    settle
  } = history
  let readRequested = false
  for (const view of views) {
    const { ptyId } = view.record
    const from = accounts.find(
      (account) => account.id === (view.record.assignedAccountId ?? view.record.accountId)
    )
    if (
      !from ||
      inflight.has(ptyId) ||
      (view.paneKey !== null && inflightPanes.has(view.paneKey))
    ) {
      continue
    }
    const own = claudeUsageForAccount(state, from, selectedId)
    const candidateAccounts = claudeMoveCandidates(accounts, from)
    const candidates = candidateAccounts
      .map((account) => claudeUsageForAccount(state, account, selectedId))
      .filter((usage): usage is InactiveAccountUsage => usage !== null)
    // The clock starts at the first wait and restarts only once the shell or monitor is gone.
    if (!view.paneBackgroundWork) {
      backgroundWaitAt.delete(ptyId)
    }
    const proxyMove = Boolean(view.record.proxySlot && deps.proxyStrategy)
    const decision = decideClaudeSessionMove({
      now,
      setting: effective,
      pinned: view.record.pinned,
      paneState: view.paneState,
      paneBackgroundWork: view.paneBackgroundWork,
      backgroundWaitStartedAt: backgroundWaitAt.get(ptyId) ?? 0,
      usage: own?.rateLimits ?? null,
      candidates,
      candidateCount: candidateAccounts.length,
      lastUsageReadAt,
      lastMoveAt: lastMoveAt.get(ptyId) ?? 0,
      lastFailureAt: lastFailureAt.get(ptyId) ?? 0,
      targetClaims,
      allowMidTurn: proxyMove,
      pool: { enabled: poolEnabled, spreadLine: proxyMove },
      ...(view.turnEndedAt !== undefined ? { turnEndedAt: view.turnEndedAt } : {})
    })
    if (
      decision.kind === 'wait' &&
      decision.reason === 'background-work' &&
      !backgroundWaitAt.has(ptyId)
    ) {
      backgroundWaitAt.set(ptyId, now)
    }
    if (decision.kind === 'read-usage') {
      remember(view, from, null, 'read-usage', own?.rateLimits ?? null, now)
      readRequested = true
      continue
    }
    if (decision.kind === 'stay' || decision.kind === 'wait') {
      const reason =
        decision.kind === 'wait'
          ? (`wait:${decision.reason}` as const)
          : decision.reason === 'off'
            ? 'off'
            : view.record.pinned && decision.reason === 'under-line'
              ? 'pinned'
              : 'stay'
      remember(view, from, null, reason, own?.rateLimits ?? null, now)
      continue
    }
    const to = accounts.find((account) => account.id === decision.to)
    if (!to) {
      continue
    }
    const balance = decision.reason === 'rebalance'
    const settled = settle(view, from, to, own?.rateLimits ?? null, balance)
    if (!view.providerSession) {
      settled('skipped', 'no-provider-session')
      continue
    }
    if (effective === 'ask') {
      if (now - (lastAskAt.get(ptyId) ?? 0) >= CLAUDE_SESSION_MOVE_COOLDOWN_MS) {
        lastAskAt.set(ptyId, now)
        remember(view, from, to, 'ask', own?.rateLimits ?? null, now)
        deps.onNotice({
          kind: 'ask',
          ptyId,
          paneKey: view.paneKey,
          from,
          to,
          detail: claudeSessionMoveNoticeDetail(
            `${decision.window.name} ${decision.window.percent}%`,
            view.paneBackgroundWork
          ),
          ...(balance ? { balance: true as const } : {})
        })
      }
      continue
    }
    if (!view.paneKey || !view.worktreeId) {
      settled('skipped', 'no-pane')
      continue
    }
    // Why the claim: five sessions over the line must not all pick the same account in one tick.
    targetClaims.set(to.id, {
      at: now,
      debit: (targetClaims.get(to.id)?.debit ?? 0) + CLAUDE_SESSION_MOVE_CLAIM_DEBIT_PERCENT
    })
    const paneKey = view.paneKey
    inflight.add(ptyId)
    // Publication can expose the replacement PTY before this move settles.
    inflightPanes.add(paneKey)
    remember(view, from, to, balance ? 'rebalance' : 'moving', own?.rateLimits ?? null, now)
    const strategy = proxyMove && deps.proxyStrategy ? deps.proxyStrategy : deps.strategy
    void strategy
      .move({
        ptyId,
        paneKey: view.paneKey,
        worktreeId: view.worktreeId,
        connectionId: null,
        toAccountId: to.id,
        providerSession: view.providerSession,
        handoff: {
          fromEmail: from.email,
          toEmail: to.email,
          detail: `${decision.window.name} ${decision.window.percent}%`,
          endedWork: endedWorkFor(deps, view)
        }
      })
      .then((outcome) => {
        if (outcome.kind === 'moved') {
          settled('moved', outcome.newPtyId)
        } else if (outcome.kind === 'skipped') {
          settled('skipped', outcome.reason)
        } else {
          settled('failed', `${outcome.reason}: ${outcome.error}`)
        }
      })
      .catch((error: unknown) => {
        settled('failed', error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        inflight.delete(ptyId)
        inflightPanes.delete(paneKey)
      })
  }
  return readRequested
}

function endedWorkFor(deps: ClaudeSessionMoverDeps, view: ClaudeMoverSessionView) {
  const rows = view.paneKey ? deps.hooks.getStatusSnapshotForPane(view.paneKey) : []
  const sessionId = view.providerSession?.id
  const row =
    rows.find((entry) => !entry.providerSessionOnly && entry.providerSession?.id === sessionId) ??
    rows.find((entry) => !entry.providerSessionOnly)
  return captureClaudeSessionMoveEndedWork({
    workingMode: row?.workingMode,
    claudeRunningNonAgentTask: view.paneKey
      ? deps.hooks.getClaudeRunningNonAgentTask(view.paneKey)
      : undefined,
    subagents: row?.subagents
  })
}
