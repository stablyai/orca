import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { agentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/structured/claude-structured-agent-definition'

// An account folder is <dataRoot>/claude-profiles/<accountId>/home; its transcripts sit in projects/.
const ACCOUNT_PROJECTS = /[\\/]claude-profiles[\\/]([A-Za-z0-9_-]+)[\\/]home[\\/]projects[\\/]/

/**
 * A terminal session has no record of its account, but one saved in an account whose history is
 * separate can only belong to that account. A shared account's folder links to System default's
 * history, so its path proves nothing and is never attributed.
 */
export function attributeIsolatedClaudeHistory(result: AiVaultListResult): AiVaultListResult {
  const router = getClaudeProfileRouter()
  if (!router) {
    return result
  }
  let changed = false
  const sessions = result.sessions.map((session) => {
    const accountId =
      session.agent === 'claude' &&
      session.accountHome === undefined &&
      session.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? ACCOUNT_PROJECTS.exec(session.filePath)?.[1]
        : undefined
    if (!accountId || !router.savedAccount(accountId)?.historyIsolated) {
      return session
    }
    const home = router.accountHome(accountId)
    if (
      !normalizeRuntimePathForComparison(session.filePath).startsWith(
        normalizeRuntimePathForComparison(home)
      )
    ) {
      return session
    }
    changed = true
    return { ...session, accountHome: agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, home) }
  })
  return changed ? { ...result, sessions } : result
}
