import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import { agentPinsAccountHome } from '../../../shared/agent-session-account-home'

export function adapterSupportsCreate(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  if (adapter.supportsCreate) {
    return adapter.supportsCreate(location, agent)
  }
  // An adapter with no per-agent gate serves the one agent it was built for, so only its location
  // support can refuse; absence still fails closed here.
  return adapter.supportsLocation?.(location) ?? false
}

/** Honors declared gates while retaining legacy adapters whose acquire path is authoritative. */
export function adapterSupportsCreateIfDeclared(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  if (!adapter.supportsCreate && !adapter.supportsLocation) {
    return true
  }
  return adapterSupportsCreate(adapter, location, agent)
}

/** Whether this build can start the agent of `session`: the agent is registered here, its account
 *  is the kind that agent pins (it becomes the child's environment), and every handle it holds is
 *  in the transport the agent's adapter speaks. A record failing this stays readable (tab, history);
 *  only starting its agent is refused, by the one launch admission every agent passes through. */
export function agentDrivesSession(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  session: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'providerHandleChain'>
): boolean {
  const definition = agents.definition(session.provider)
  return (
    definition !== null &&
    agentPinsAccountHome(definition, session.accountHome) &&
    session.providerHandleChain.every(
      ({ handle }) =>
        handle.transport === definition.handleTransport && handle.agent === definition.agent
    )
  )
}

/** Whether this host can start `record`'s agent: the adapter runs its location and this build
 *  drives it. The restart offer, a retry, the pre-send check and the start itself all ask this, so
 *  none offers what the start refuses. Reading the stored chat needs no adapter. */
export function hostCanStartRecord(
  deps: {
    adapter: StructuredAgentSessionAdapter
    agents: Pick<StructuredAgentRegistry, 'definition'>
  },
  record: AgentSessionRecord
): boolean {
  return (
    adapterSupportsCreateIfDeclared(deps.adapter, record.location, record.provider) &&
    agentDrivesSession(deps.agents, record)
  )
}
