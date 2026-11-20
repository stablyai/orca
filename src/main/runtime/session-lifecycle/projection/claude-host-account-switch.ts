import { normalizeCodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { claudeLaunchAccountId } from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import type { ClaudeAccountSelectionChange } from '../../../../shared/agent-accounts/managed-account-types'

/** The launch accounts a selection goes between, and whether it moves the host's own: a WSL lane
 *  keeps its own pointer, and the same account again moves nothing. */
export function claudeHostAccountSwitch(change: ClaudeAccountSelectionChange): {
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
