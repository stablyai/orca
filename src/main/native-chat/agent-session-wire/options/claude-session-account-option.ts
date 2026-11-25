import { acquiredAgentSessionAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import { agentSessionAccountHomePath } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import { aiVaultSessionClaudeAccountId } from '../../../../shared/ai-vault/session-display/ai-vault-session-claude-account'

/** The saved Claude account a host chat last ran on, read from its launch receipt; a chat that has
 *  not run yet reads the account it was created on. WSL chats name guest folders, so none. */
export function claudeSessionAccountOption(
  record: AgentSessionRecord | undefined | null
): Pick<AgentSessionOptionsResult, 'claudeAccountId'> {
  if (record?.provider !== 'claude' || record.location.wslDistro !== null) {
    return {}
  }
  const recipe = acquiredAgentSessionAccount(record)?.recipe
  if (recipe) {
    return { claudeAccountId: recipe.route === 'managed' ? recipe.accountId : null }
  }
  const home = agentSessionAccountHomePath(record.accountHome)
  if (home === null) {
    return {}
  }
  const accountId = aiVaultSessionClaudeAccountId({
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home }
  })
  return accountId === undefined ? {} : { claudeAccountId: accountId }
}
