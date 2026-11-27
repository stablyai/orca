import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import {
  agentSessionAccountHome,
  type LegacyAgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  keptProviderRelaySpawnToken,
  keptRunningProviderRelayPid
} from '../../provider-relay/app-provider-relays'
import { CLAUDE_STRUCTURED_AGENT } from '../structured/claude-structured-agent-definition'

/**
 * A kept agent keeps the account it was started under, whatever was picked since: its reattach
 * publishes that one (from the receipt its launch wrote), so the next message's account check
 * sees a change and replaces the agent. Null without a kept agent or a receipt that is its own.
 */
export function keptClaudeAgentAccountHome(
  record: AgentSessionRecord
): LegacyAgentSessionAccountHome | null {
  if (keptRunningProviderRelayPid(record.sessionId) === null) {
    return null
  }
  const receipt = acquiredAgentSessionAccount(record)
  const token = keptProviderRelaySpawnToken(record.sessionId)
  if (!receipt || (token !== null && receipt.spawnToken !== token)) {
    return null
  }
  return agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, receipt.recipe.home)
}
