import type { RuntimeCreateAgentSessionResult } from '../../../../shared/agent-session/agent-session-host-authority'

/** Identity a fenced spawn can be re-found by in the execution host's own inventory. */
export type AgentSessionCreateReclaimIdentity = {
  worktreeId: string
  connectionId: string | null
  terminalHandle: string
}

export type AgentSessionCreateOperation = {
  fingerprint: string
  promise: Promise<RuntimeCreateAgentSessionResult>
  // Lost spawn replies can leave unnamed live PTYs; replay adopts by this original launch identity.
  reclaim: { identity?: AgentSessionCreateReclaimIdentity }
}
