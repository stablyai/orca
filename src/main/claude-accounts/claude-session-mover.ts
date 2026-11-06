import { CLAUDE_SESSION_MOVE_COOLDOWN_MS } from './claude-session-mover-policy'
import { collectClaudeMoverSessions } from './claude-session-mover-sessions'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'
import type { ClaudeSessionMover, ClaudeSessionMoverDeps } from './claude-session-mover-types'
export type {
  ClaudeSessionMover,
  ClaudeSessionMoverDeps,
  ClaudeSessionMoveNotice
} from './claude-session-mover-types'
import { createClaudeMoverHistory, type ClaudeMoverHistory } from './claude-session-mover-history'
import { evaluateClaudeMoverSessions } from './claude-session-mover-evaluation'

export function createClaudeSessionMover(deps: ClaudeSessionMoverDeps): ClaudeSessionMover {
  // Filled before any notice. createClaudeMoverHistory does not publish during construction.
  const historyBox: { current: ClaudeMoverHistory | null } = { current: null }
  const snapshotMoves = (): ReturnType<ClaudeSessionMover['lastDecisions']> => {
    const decisions = historyBox.current?.lastDecision
    if (!decisions) {
      return []
    }
    const live = new Set(deps.registry.list().map((record) => record.ptyId))
    return [...decisions.values()]
      .filter((record) => live.has(record.ptyId))
      .sort((a, b) => b.at - a.at)
  }
  const publishing: ClaudeSessionMoverDeps = {
    ...deps,
    onNotice: (notice) => deps.onNotice({ ...notice, moves: snapshotMoves() })
  }
  const history = createClaudeMoverHistory(publishing)
  historyBox.current = history
  const { lastMoveAt, lastFailureAt, lastAskAt, backgroundWaitAt, lastDecision, targetClaims } =
    history
  let lastUsageReadAt = 0
  let headlessAskLogged = false
  let evaluating = false
  let queued = false
  let stopped = false

  const evaluateOnce = (): void => {
    const settings = deps.getSettings()
    const setting = settings.claudeSessionMover ?? 'ask'
    const effective = setting === 'ask' && deps.headless ? 'move' : setting
    if (effective !== setting && !headlessAskLogged) {
      headlessAskLogged = true
      console.info(
        '[claude-session-mover] setting is "ask" on a headless host; nobody can answer, so it acts as "move"'
      )
    }
    const now = Date.now()
    const state = deps.rateLimits.getState()
    const accounts = deps.accounts.listAccounts().accounts
    const selectedId = getSelectedClaudeAccountIdForTarget(settings, state.claudeTarget)
    const views = collectClaudeMoverSessions({
      records: deps.registry.list(),
      statuses: deps.hooks.getStatusChangeSnapshot(),
      providerSessions: deps.hooks.getProviderSessionIdentities(),
      resolveProviderSession: (paneKey, sessionId) =>
        deps.hooks
          .getStatusSnapshotForPane(paneKey)
          .find((row) => row.providerSession?.id === sessionId)?.providerSession ?? null,
      resolvePaneKey: deps.resolvePaneKey,
      resolvePtyIdForPaneKey: deps.resolvePtyIdForPaneKey,
      resolveWorktreeId: deps.resolveWorktreeId,
      accounts: settings.claudeManagedAccounts.map((account) => ({
        id: account.id,
        homes: [account.managedAuthPath, ...deps.accountHomes(account.id)]
      })),
      recordInferred: deps.registry.record,
      now
    })
    const live = new Set(views.map((view) => view.record.ptyId))
    for (const map of [lastMoveAt, lastFailureAt, lastAskAt, backgroundWaitAt, lastDecision]) {
      for (const ptyId of map.keys()) {
        if (!live.has(ptyId)) {
          map.delete(ptyId)
        }
      }
    }
    for (const [accountId, claim] of targetClaims) {
      if (now - claim.at >= CLAUDE_SESSION_MOVE_COOLDOWN_MS) {
        targetClaims.delete(accountId)
      }
    }
    const readRequested = evaluateClaudeMoverSessions(
      publishing,
      history,
      views,
      state,
      accounts,
      selectedId,
      now,
      effective,
      lastUsageReadAt,
      settings.claudeAccountPool === 'on'
    )
    if (readRequested) {
      lastUsageReadAt = now
      // Why deferred: the usage service publishes from inside this call, and this runs mid-publish.
      queueMicrotask(() => {
        if (stopped) {
          return
        }
        deps.rateLimits
          .fetchInactiveClaudeAccountsOnOpen()
          .catch((error: unknown) =>
            console.warn('[claude-session-mover] Failed to read inactive Claude usage:', error)
          )
      })
    }
  }

  const evaluate = (): void => {
    if (stopped) {
      return
    }
    if (evaluating) {
      queued = true
      return
    }
    evaluating = true
    try {
      evaluateOnce()
    } finally {
      evaluating = false
      if (queued) {
        queued = false
        queueMicrotask(evaluate)
      }
    }
  }

  return {
    start: () => {
      stopped = false
      const unsubscribeState = deps.rateLimits.onStateChange(() => evaluate())
      const unsubscribeStatus = deps.hooks.subscribeStatusChanges(() => evaluate())
      return () => {
        stopped = true
        unsubscribeState()
        unsubscribeStatus()
      }
    },
    evaluate,
    lastDecisions: snapshotMoves
  }
}
