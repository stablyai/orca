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
  // Legacy single-agent adapters may refuse only location; absent support still fails closed.
  return adapter.supportsLocation?.(location) ?? false
}

/** Honor declared create gates; retain legacy adapters with authoritative spawn paths. */
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

/** Admit registered agents with compatible pinned accounts/handle transports; unsupported chats stay readable. */
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

/** Share launch support checks with restart/retry offers; stored history needs no adapter. */
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

/** Include saved chats whose agents are no longer registered when bounding client audiences. */
export function knownAgentIds(deps: {
  agents: Pick<StructuredAgentRegistry, 'definitions'>
  store: { listRecords: () => readonly Pick<AgentSessionRecord, 'provider'>[] }
}): readonly string[] {
  return [
    ...new Set([
      ...deps.agents.definitions().map(({ agent }) => agent),
      ...deps.store.listRecords().map(({ provider }) => provider)
    ])
  ]
}
