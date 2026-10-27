// Reject capabilities without adapter implementations so declarations remain trustworthy.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
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
    ...(capabilities.compact ? (['compact'] as const) : []),
    ...(capabilities.threadGoal ? (['changeThreadGoal'] as const) : []),
    ...(capabilities.rewind && !adapter.forkForRewind ? (['rewind', 'recoverRewind'] as const) : [])
  ]
}

export class StructuredAgentRegistry {
  private readonly byAgent: ReadonlyMap<string, StructuredAgentRegistration>

  constructor(registrations: readonly StructuredAgentRegistration[]) {
    const byAgent = new Map<string, StructuredAgentRegistration>()
    for (const registration of registrations) {
      const { agent, capabilities } = registration.definition
      if (byAgent.has(agent)) {
        throw new Error(`structured agent ${agent} is registered twice`)
      }
      const missing = requiredAdapterMethods(capabilities, registration.adapter).find(
        (method) => !registration.adapter[method]
      )
      if (missing) {
        throw new Error(
          `structured agent ${agent} declares a capability its adapter has no ${missing} for`
        )
      }
      byAgent.set(agent, registration)
    }
    this.byAgent = byAgent
  }

  registration(agent: string): StructuredAgentRegistration | null {
    return this.byAgent.get(agent) ?? null
  }

  registrations(): readonly StructuredAgentRegistration[] {
    return [...this.byAgent.values()]
  }

  definition(agent: string): StructuredAgentDefinition | null {
    return this.byAgent.get(agent)?.definition ?? null
  }

  definitions(): readonly StructuredAgentDefinition[] {
    return this.registrations().map((registration) => registration.definition)
  }

  /** Live sessions may narrow declared capabilities, never widen them. */
  capabilities(agent: string): AgentSessionCapabilities | null {
    return this.definition(agent)?.capabilities ?? null
  }
}
