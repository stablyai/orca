import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentLaunchPartResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { selectAcpHostAccountHome } from './acp-launch-command'

type LaunchBasis = Parameters<StructuredAgentLaunchPartResolver<unknown>>[0]

/** A chat that hasn't started a conversation follows the agent's current selection (Antigravity's
 *  saved sign-in method), so a method picked before its first turn applies to it. One with a
 *  conversation keeps the home that conversation lives in. */
export async function homeBeforeFirstTurn(
  agentSpec: AcpLaunchSpec,
  record: AgentSessionRecord,
  basis: Pick<LaunchBasis, 'baseEnvironment' | 'commandSettings'>,
  dataDirectory: string
): Promise<AgentSessionAccountHome | null> {
  const backend = agentSpec.hostBackend
  if (
    !backend?.followsSelectionBeforeFirstTurn ||
    record.providerHandleChain.length > 0 ||
    !backend.pins(record.accountHome)
  ) {
    return null
  }
  const selected = await selectAcpHostAccountHome(
    agentSpec,
    await basis.baseEnvironment(),
    dataDirectory,
    basis.commandSettings?.() ?? {}
  )
  return selected && !agentSessionAccountHomesEqual(selected, record.accountHome) ? selected : null
}
