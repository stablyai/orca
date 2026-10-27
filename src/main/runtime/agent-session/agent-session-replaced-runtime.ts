// The profile lock proves replaced host runtimes lost their pipes, not that provider processes died.
// Attribute only runtimes this host replaced; terminal claims and unknown owners provide no such evidence.

import type { AgentSessionOrcaStopCause } from '../../../shared/agent-session-orca-stop'
import {
  listAgentSessionConversations,
  type AgentSessionStoreState
} from '../agent-session-store-state'

export type AgentSessionReplacedRuntime = {
  /** The highest fence a replaced runtime granted; every lower fence was granted before it. */
  fence: number
  /** The last renewal of the owner loaded at `fence`, its last proof of life. */
  lastProvenAliveAt?: number
  /** How the runtime holding the owner loaded at `fence` ended, when its record says. */
  runtimeEnd?: AgentSessionOrcaStopCause
}

export function agentSessionReplacedRuntimes(
  state: AgentSessionStoreState,
  args: { hostId: string; incarnation: string }
): ReadonlyMap<string, AgentSessionReplacedRuntime> {
  const replaced = new Map<string, AgentSessionReplacedRuntime>()
  for (const { sessionId, ownerObservation: lease, currentFence } of listAgentSessionConversations(
    state
  )) {
    const owner = lease.ownerProcess
    // Exclude terminal claims, other hosts and this process's reinstalled runtime, which may still own a live transport.
    if (
      lease.claimStatus === 'conflicted' ||
      (owner && (owner.hostId !== args.hostId || owner.runtime === args.incarnation))
    ) {
      continue
    }
    const runtimeEnd = owner?.runtime ? state.runtimeEnds?.get(owner.runtime) : undefined
    replaced.set(sessionId, {
      fence: currentFence,
      ...(owner ? { lastProvenAliveAt: lease.lastRenewedAt } : {}),
      ...(runtimeEnd ? { runtimeEnd } : {})
    })
  }
  return replaced
}
