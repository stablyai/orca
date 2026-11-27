import {
  customAcpAgentId,
  readCustomAcpAgents,
  type CustomAcpAgent
} from '../../../shared/agent-launch/custom-acp/custom-acp-agents'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import { directoryAccountBinding } from './acp-account-binding'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { nameCustomAcpAgents } from '../../../shared/agent-launch/custom-acp/custom-acp-agent-names'

/** A user's own ACP agent: their command line and environment, the protocol as the agent speaks it. */
export function customAcpLaunchSpec(agent: CustomAcpAgent): AcpLaunchSpec {
  const agentId = customAcpAgentId(agent)
  return {
    agent: agentId,
    name: agent.name,
    command: agent.command,
    // The built-in agents' Command settings never apply to a command the user wrote here.
    ignoreAgentCommandSetting: true,
    args: () => [...agent.args],
    env: agent.env,
    dialect: GENERIC_ACP_DIALECT,
    loginCommand: [],
    // It keeps the user's own home: Orca manages no account for it.
    account: directoryAccountBinding('HOME', (homePath) => homePath),
    installDirectories: () => [],
    // Its models, if any, come with the chat's own configOptions.
    modelDiscovery: {
      kind: 'unavailable',
      reason: `${agent.name} lists its models inside a chat`
    },
    transcriptImport: null,
    sessionHistory: {
      rowAgents: [],
      rowSessionId: (link) => link.handle.nativeId,
      parseResumeArgs: () => null
    }
  }
}

let customSpecs: readonly AcpLaunchSpec[] = []

/** Read from the host's settings once, before the chat runtime installs its agents. */
export function adoptCustomAcpAgents(saved: unknown): void {
  const agents = readCustomAcpAgents(saved)
  nameCustomAcpAgents(agents.map((agent) => ({ agent: customAcpAgentId(agent), name: agent.name })))
  customSpecs = agents.map(customAcpLaunchSpec)
}

export function customAcpLaunchSpecs(): readonly AcpLaunchSpec[] {
  return customSpecs
}
