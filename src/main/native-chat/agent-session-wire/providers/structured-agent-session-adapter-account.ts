// Which saved account a child launched on, for an agent whose saved accounts swap one login inside
// one home, so the home alone can't tell them apart.

import type { StructuredAgentSessionAdapterPermission } from './structured-agent-session-adapter-permission'
import type { StructuredAgentSessionAdapterStop } from './structured-agent-session-adapter-stop'

export type StructuredAgentSessionAdapterAccount = {
  /** The account key a start of this session would record now; a running child whose
   *  `accountKey` differs launched on another account. Null when the agent has none. */
  launchAccountKey?(sessionId: string): string | null
}

/** How a provider stops, changes the permission mode of, and names the account of its children. */
export type StructuredAgentSessionAdapterControls = StructuredAgentSessionAdapterStop &
  StructuredAgentSessionAdapterPermission &
  StructuredAgentSessionAdapterAccount
