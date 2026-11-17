import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { withClaudeProfileTerminalEnv } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { claudeChosenAccountUnsupported } from '../../../claude-accounts/profiles/routing/claude-profile-launch-errors'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import type { PrepareClaudeAuth } from '../host-env/types'

/** The spawn's Claude account: the selection, or the saved account an `agent.launch.before` plugin chose. */
export async function prepareSpawnClaudeAccount(input: {
  env: Record<string, string> | undefined
  target: CodexAccountSelectionTarget
  isClaudeLaunch: boolean
  /** An SSH terminal: its host prepares its own accounts. */
  remote: boolean
  prepareClaudeAuth: PrepareClaudeAuth | undefined
  pluginAccountId: string | undefined
}): Promise<{
  env: Record<string, string> | undefined
  claudeAuth: ClaudeRuntimeAuthPreparation | null
}> {
  const { target, prepareClaudeAuth, pluginAccountId } = input
  const env = withClaudeProfileTerminalEnv(input.env, target)
  if (pluginAccountId === undefined) {
    const claudeAuth =
      input.isClaudeLaunch && prepareClaudeAuth ? await prepareClaudeAuth(target) : null
    return { env, claudeAuth }
  }
  if (!input.isClaudeLaunch || input.remote || !prepareClaudeAuth) {
    throw claudeChosenAccountUnsupported()
  }
  const claudeAuth = await prepareClaudeAuth(target, pluginAccountId)
  // A patch cannot delete, so the selection's folder is dropped before the chosen patch applies.
  const unrouted = { ...env }
  delete unrouted.CLAUDE_CONFIG_DIR
  delete unrouted[CLAUDE_INJECTED_CONFIG_DIR_ENV]
  return { env: unrouted, claudeAuth }
}
