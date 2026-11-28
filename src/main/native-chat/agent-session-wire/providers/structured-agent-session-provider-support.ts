import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import { agentPinsAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

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

/** A transport migration (OMP's ACP-to-RPC cutover) strands same-agent handles nothing can resume; drop only those relics. */
export function migrationAdjustedHandleChain<
  L extends { handle: { transport: string; agent: string } }
>(definition: { agent: string; handleTransport: string }, chain: readonly L[]): L[] {
  return chain.filter(
    (link) =>
      link.handle.transport === definition.handleTransport || link.handle.agent !== definition.agent
  )
}

/** agentDrivesSession after dropping migration relics; the launch path re-filters so stored chains stay intact. */
export function agentDrivesSessionMigrating(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  session: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'providerHandleChain'>
): boolean {
  if (agentDrivesSession(agents, session)) {
    return true
  }
  const definition = agents.definition(session.provider)
  if (!definition) {
    return false
  }
  const adjusted = migrationAdjustedHandleChain(definition, session.providerHandleChain)
  return (
    adjusted.length !== session.providerHandleChain.length &&
    agentDrivesSession(agents, { ...session, providerHandleChain: adjusted })
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
    agentDrivesSessionMigrating(deps.agents, record)
  )
}

/** Include saved chats whose agents are no longer registered when bounding client audiences. */
export function knownAgentIds(deps: {
  agents: Pick<StructuredAgentRegistry, 'definitions'>
  store: { listConversations: () => readonly Pick<AgentSessionRecord, 'provider'>[] }
}): readonly string[] {
  return [
    ...new Set([
      ...deps.agents.definitions().map(({ agent }) => agent),
      ...deps.store.listConversations().map(({ provider }) => provider)
    ])
  ]
}
