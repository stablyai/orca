// Agent modules declare definitions; the runtime registry owns shared lookup instead of agent-name branches.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionStoredAgent } from '../../../shared/agent-session/lifecycle/agent-session-stored-agent'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

export type StructuredAgentDefinition = AgentSessionStoredAgent & {
  capabilities: AgentSessionCapabilities
  /** Absent means Orca never supplies this agent’s managed runtime. */
  managedRuntime?: () => boolean
  restingOptions: {
    acceptsKey: (key: string) => boolean
    /** Null means no fallback catalog. */
    fallbackModels: () => AgentSessionModelOption[] | null
    /** Unpicked effort follows the model default, matching running-child reports. */
    effortDefaultsToModel: boolean
  }
}

/** Accounts represented by a single config directory. */
export type DirectoryAccountAgentDefinition = StructuredAgentDefinition & {
  accountHomeVariable: string
}
