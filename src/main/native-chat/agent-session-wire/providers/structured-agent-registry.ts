// Reject capabilities without adapter implementations so declarations remain trustworthy.

import type { AgentSessionCapabilities } from '../../../../shared/agent-session/capabilities/agent-session-capabilities'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export type StructuredAgentRegistration = {
  definition: StructuredAgentDefinition
  adapter: StructuredAgentSessionAdapter
}

type AdapterMethod = keyof StructuredAgentSessionAdapter

/** Rewind may use provider recovery or a fork on next launch. */
function requiredAdapterMethods(
  capabilities: AgentSessionCapabilities,
  adapter: StructuredAgentSessionAdapter
): AdapterMethod[] {
  return [
    ...(capabilities.fork ? (['copyConversation'] as const) : []),
    ...(capabilities.compact ? (['compact'] as const) : []),
    ...(capabilities.threadGoal ? (['changeThreadGoal'] as const) : []),
    ...(capabilities.rewind && !adapter.forkForRewind ? (['rewind', 'recoverRewind'] as const) : [])
  ]
}

function assertAdapterCoversCapabilities(registration: StructuredAgentRegistration): void {
  const { agent, capabilities } = registration.definition
  const missing = requiredAdapterMethods(capabilities, registration.adapter).find(
    (method) => !registration.adapter[method]
  )
  if (missing) {
    throw new Error(
      `structured agent ${agent} declares a capability its adapter has no ${missing} for`
    )
  }
}

/** Agents that settings define after the host starts: the definition they have now, and the adapter
 *  built for them once. */
export type StructuredAgentLateRegistrations = {
  definition(agent: string): StructuredAgentDefinition | null
  createAdapter(agent: string): StructuredAgentSessionAdapter
  /** The late agents defined now, for listings. */
  agents(): readonly string[]
}

export class StructuredAgentRegistry {
  private readonly byAgent: ReadonlyMap<string, StructuredAgentRegistration>
  // A late agent keeps its adapter after it is removed from settings, so its running chats close.
  private readonly lateAdapters = new Map<string, StructuredAgentSessionAdapter>()

  constructor(
    registrations: readonly StructuredAgentRegistration[],
    private readonly late?: StructuredAgentLateRegistrations
  ) {
    const byAgent = new Map<string, StructuredAgentRegistration>()
    for (const registration of registrations) {
      const { agent } = registration.definition
      if (byAgent.has(agent)) {
        throw new Error(`structured agent ${agent} is registered twice`)
      }
      assertAdapterCoversCapabilities(registration)
      byAgent.set(agent, registration)
    }
    this.byAgent = byAgent
  }

  registration(agent: string): StructuredAgentRegistration | null {
    return this.byAgent.get(agent) ?? this.lateRegistration(agent)
  }

  registrations(): readonly StructuredAgentRegistration[] {
    const late = (this.late?.agents() ?? []).flatMap((agent) => this.lateRegistration(agent) ?? [])
    return [...this.byAgent.values(), ...late]
  }

  /** Every adapter built, a removed late agent's included, so closing the host closes its chats. */
  adapters(): readonly StructuredAgentSessionAdapter[] {
    return [
      ...[...this.byAgent.values()].map(({ adapter }) => adapter),
      ...this.lateAdapters.values()
    ]
  }

  private lateRegistration(agent: string): StructuredAgentRegistration | null {
    if (!this.late || this.byAgent.has(agent)) {
      return null
    }
    const definition = this.late.definition(agent)
    if (!definition) {
      return null
    }
    let adapter = this.lateAdapters.get(agent)
    if (!adapter) {
      adapter = this.late.createAdapter(agent)
      assertAdapterCoversCapabilities({ definition, adapter })
      this.lateAdapters.set(agent, adapter)
    }
    return { definition, adapter }
  }

  definition(agent: string): StructuredAgentDefinition | null {
    return this.byAgent.get(agent)?.definition ?? this.late?.definition(agent) ?? null
  }

  definitions(): readonly StructuredAgentDefinition[] {
    return this.registrations().map((registration) => registration.definition)
  }

  /** Live sessions may narrow declared capabilities, never widen them. */
  capabilities(agent: string): AgentSessionCapabilities | null {
    return this.definition(agent)?.capabilities ?? null
  }
}
