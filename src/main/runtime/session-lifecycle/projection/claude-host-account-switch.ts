import { normalizeCodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  claudeLaunchAccountId,
  type ClaudeHostSelectionChange
} from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'

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

/** An answer restarts what its Ask left, unless a later switch moved the host off that account. */
export function answeredClaudeMove(
  asked: ClaudeHostSelectionChange | undefined,
  change: ClaudeHostSelectionChange
): ClaudeHostSelectionChange | undefined {
  if (!asked || change.answersAskFor === undefined) {
    return undefined
  }
  const { state } = change.after
  const selected = claudeLaunchAccountId(state, change.after.accountId)
  return selected === claudeLaunchAccountId(state, change.answersAskFor) &&
    selected === claudeLaunchAccountId(asked.after.state, asked.after.accountId)
    ? { ...asked, after: change.after, runningSessions: 'restart' }
    : undefined
}
