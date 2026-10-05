import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentType } from '../../shared/agent-status-types'
import {
  resolveCompatibleAgentTypeForOwner,
  type CompatibleAgentOwnerOptions
} from '../../shared/agent-title-owner'
import type { TerminalConversationIdentity } from '../../shared/terminal-conversation-identity'
import type { StoredAgentConversationRead } from '../agent-hooks/server/server-types'

export type GetAgentConversationForPane = (
  paneKey: string,
  terminalHandle?: string | null
) => StoredAgentConversationRead | undefined

/** Unknown session provenance disproves nothing; a known one must share the agent's compatible group. */
export function providerSessionMatchesAgent(args: {
  sessionAgent: AgentType | null | undefined
  agent: AgentType | null | undefined
  ownerAgent: AgentType | null | undefined
  ownerOptions: CompatibleAgentOwnerOptions
}): boolean {
  const sessionAgent = resolveCompatibleAgentTypeForOwner(
    args.sessionAgent,
    args.ownerAgent,
    args.ownerOptions
  )
  return !args.agent || !sessionAgent || args.agent === sessionAgent
}

/** A status row's address, for stores or rows that hold no facet. */
export type LegacyIdentityCandidate = {
  providerSession: AgentProviderSessionMetadata
  /** The agent that reported this session, when the row recorded it. */
  sessionAgent: AgentType | null
  model?: string
  modelSwitchCommand?: 'orca-model'
  capturedAt: number
  source: 'legacy-row' | 'renderer'
}

/** Why: Agent Teams runs the real `claude` binary, whose hooks always report `claude`. */
function currentEvidenceAgent(agent: AgentType | null): AgentType | null {
  return agent === 'claude-agent-teams' ? 'claude' : agent
}

/**
 * The pane's published identity, or `undefined` (absent) when the host holds none it can vouch for
 * here. A facet is published only for the agent the pane holds now: it must match every piece of
 * current evidence (a live row's agent, the recognized foreground agent), else the launch/hook
 * owner; another agent's conversation is withheld, never published as empty.
 */
export function resolveTerminalConversationIdentity(args: {
  stored: StoredAgentConversationRead | undefined
  legacy: LegacyIdentityCandidate | null
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
  foregroundAgent: AgentType | null
}): TerminalConversationIdentity | undefined {
  const { stored, ownerAgent, ownerOptions } = args
  if (stored) {
    const facet = stored.facet
    const matchesFacet = (agent: AgentType | null): boolean =>
      providerSessionMatchesAgent({
        sessionAgent: facet.agentType,
        agent,
        ownerAgent: agent,
        ownerOptions
      })
    // Why: a remnant names the agent that left, and launch provenance outlives its agent.
    const currentAgents = [
      stored.rowIsRemnant ? null : stored.rowAgent,
      currentEvidenceAgent(args.foregroundAgent)
    ].filter((agent): agent is AgentType => agent !== null)
    const checkedAgents = currentAgents.length > 0 ? currentAgents : [ownerAgent]
    if (!checkedAgents.every(matchesFacet)) {
      return undefined
    }
    // Why: name the pane's agent as the status does: the owner when compatible, else the current agent.
    const namedAgent = [ownerAgent, ...currentAgents].find(
      (agent) => agent !== null && matchesFacet(agent)
    )
    return {
      ...facet,
      agentType:
        resolveCompatibleAgentTypeForOwner(facet.agentType, namedAgent, ownerOptions) ??
        facet.agentType,
      source: stored.rowIsRemnant ? 'retained' : 'live'
    }
  }
  const legacy = args.legacy
  // Why: an aged remnant with no launch hint keeps its reporting agent as the owner.
  const agentType = ownerAgent ?? legacy?.sessionAgent
  if (
    !legacy ||
    !agentType ||
    !providerSessionMatchesAgent({
      sessionAgent: legacy.sessionAgent,
      agent: agentType,
      ownerAgent,
      ownerOptions
    })
  ) {
    return undefined
  }
  return {
    agentType,
    providerSession: legacy.providerSession,
    ...(legacy.model ? { model: legacy.model } : {}),
    ...(legacy.modelSwitchCommand ? { modelSwitchCommand: legacy.modelSwitchCommand } : {}),
    capturedAt: legacy.capturedAt,
    source: legacy.source
  }
}
