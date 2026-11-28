import { normalizeCodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  claudeLaunchAccountId,
  resolveClaudePaneFolder,
  type ClaudeHostFolders,
  type ClaudeHostSelectionChange,
  type ClaudePaneFolder
} from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import type {
  ClaudeHostRunningSessionsMove,
  ClaudeManagedAccount
} from '../../../../shared/agent-accounts/managed-account-types'

/** The launch accounts a selection goes between, and whether it moves the host's own: a WSL lane
 *  keeps its own pointer, and the same account again moves nothing. */
export function claudeHostAccountSwitch(change: ClaudeHostSelectionChange): {
  fromAccountId: string | null
  toAccountId: string | null
  movesHost: boolean
} {
  const fromAccountId = claudeLaunchAccountId(change.before.state, change.before.accountId)
  const toAccountId = claudeLaunchAccountId(change.after.state, change.after.accountId)
  return {
    fromAccountId,
    toAccountId,
    movesHost:
      normalizeCodexAccountSelectionTarget(change.target).runtime === 'host' &&
      fromAccountId !== toAccountId
  }
}

export type AskedClaudeMove = {
  change: ClaudeHostSelectionChange
  askId: string
  /** Exact PTYs counted by this Ask, so answering it never stops sessions added or unheld later. */
  ptyIds: ReadonlySet<string>
}

export function countClaudeSessionHolders(
  panes: readonly { session: { id: string } | null }[]
): Map<string, number> {
  const holders = new Map<string, number>()
  for (const { session } of panes) {
    if (session) {
      holders.set(session.id, (holders.get(session.id) ?? 0) + 1)
    }
  }
  return holders
}

export function buildClaudeHostMoveSummary(
  restarting: number,
  notMoved: number,
  canRestart: number,
  askId: string | undefined
): ClaudeHostRunningSessionsMove | undefined {
  if (restarting + notMoved === 0) {
    return undefined
  }
  return {
    restarting,
    notMoved,
    ...(canRestart ? { canRestart } : {}),
    ...(askId ? { askId } : {})
  }
}

export function resolveHostClaudePaneFolder(
  restarted: { accountId: string | null | undefined } | undefined,
  transcriptPath: string | undefined,
  saved: readonly ClaudeManagedAccount[],
  host: ClaudeHostFolders,
  platform: NodeJS.Platform
): ClaudePaneFolder | undefined {
  if (restarted) {
    if (restarted.accountId === undefined) {
      return undefined
    }
    return restarted.accountId === null
      ? { kind: 'system-default' }
      : { kind: 'account', accountId: restarted.accountId }
  }
  return resolveClaudePaneFolder(transcriptPath, saved, host, platform)
}

/** An answer restarts what its Ask left, unless a later switch moved the host off that account.
 *  Checked against the host's selection now, never the snapshot the answering toast kept. */
export function answeredClaudeMove(
  asked: AskedClaudeMove | undefined,
  change: ClaudeHostSelectionChange,
  current: ClaudeHostFolders & { activeAccountId: string | null }
): { change: ClaudeHostSelectionChange; ptyIds: ReadonlySet<string> } | undefined {
  if (!asked || change.answersAskFor === undefined) {
    return undefined
  }
  if (change.answersAskId !== undefined && change.answersAskId !== asked.askId) {
    return undefined
  }
  const selected = claudeLaunchAccountId(current, current.activeAccountId)
  return selected === claudeLaunchAccountId(current, change.answersAskFor) &&
    selected === claudeLaunchAccountId(asked.change.after.state, asked.change.after.accountId)
    ? {
        change: {
          ...asked.change,
          after: { state: current, accountId: current.activeAccountId },
          runningSessions: 'restart'
        },
        ptyIds: asked.ptyIds
      }
    : undefined
}
