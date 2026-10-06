// What the host knows about a structured agent before any session of it runs.
//
// Each agent's own module declares its definition, and runtime composition registers it with the
// agent's adapter in one StructuredAgentRegistry. That registry is the only lookup: the router and
// shared host code read a definition through it and never branch on the agent's name.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

export type StructuredAgentDefinition = {
  /** The Orca agent whose sessions this definition describes. */
  agent: string
  capabilities: AgentSessionCapabilities
  /** How a session's options read and change while no child runs. */
  restingOptions: {
    /** Whether the agent takes a pick of this option key. */
    acceptsKey: (key: string) => boolean
    /** The models a running child falls back to with no catalog; null when it has none. */
    fallbackModels: () => AgentSessionModelOption[] | null
    /** An unpicked effort reads as the model's default effort, as a running child reports it. */
    effortDefaultsToModel: boolean
  }
}
