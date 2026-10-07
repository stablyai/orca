// The structured agents this runtime drives, built once from their registrations.
//
// The one place a definition is looked up: the router routes with it and every host reader asks it
// what an agent declares. A declaration the agent's adapter could not honour is refused here, so a
// declared capability always has the adapter method behind it.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

/** One structured agent this runtime drives: its definition, and the adapter that runs it. */
export type StructuredAgentRegistration = {
  definition: StructuredAgentDefinition
  adapter: StructuredAgentSessionAdapter
}

type AdapterMethod = keyof StructuredAgentSessionAdapter

/** The adapter methods each declared capability needs. */
function requiredAdapterMethods(capabilities: AgentSessionCapabilities): AdapterMethod[] {
  return [
    ...(capabilities.compact ? (['compact'] as const) : []),
    ...(capabilities.threadGoal ? (['changeThreadGoal'] as const) : []),
    ...(capabilities.rewind ? (['rewind', 'recoverRewind'] as const) : [])
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
      const missing = requiredAdapterMethods(capabilities).find(
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

  /** The registration for `agent`; null for an agent this runtime does not drive. */
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

  /** What `agent` declares; a live session may narrow it (see `rewindSupport`), never widen it. */
  capabilities(agent: string): AgentSessionCapabilities | null {
    return this.definition(agent)?.capabilities ?? null
  }
}
