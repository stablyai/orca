// The profile lock proves replaced host runtimes lost their pipes, not that provider processes died.
// Attribute only runtimes this host replaced; terminal claims and unknown owners provide no such evidence.

import {
  keptRunningProviderRelayPid,
  providerRelayReattached
} from '../../../provider-relay/app-provider-relays'
import type { AgentSessionOrcaStopCause } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-orca-stop'
import {
  listAgentSessionConversations,
  type AgentSessionStoreState
} from '../records/agent-session-store-state'

export type AgentSessionReplacedRuntime = {
  /** The replaced runtime that held the owner loaded at `fence`, when the lease names it. */
  runtime?: string
  /** The highest fence a replaced runtime granted; every lower fence was granted before it. */
  fence: number
  /** Its writer kept running under the terminal host and this app reattached it: nothing ended. */
  kept?: true
  /** The last renewal of the owner loaded at `fence`, its last proof of life. */
  lastProvenAliveAt?: number
  /** How the runtime holding the owner loaded at `fence` ended, when its record says. */
  runtimeEnd?: AgentSessionOrcaStopCause
}

/** A reattached kept writer is the replaced runtime's own agent, still running its turn. */
class KeptWriterAwareReplacedRuntimes extends Map<string, AgentSessionReplacedRuntime> {
  override get(sessionId: string): AgentSessionReplacedRuntime | undefined {
    const replaced = super.get(sessionId)
    return replaced &&
      (providerRelayReattached(sessionId) || keptRunningProviderRelayPid(sessionId) !== null)
      ? { ...replaced, kept: true }
      : replaced
  }
}

export function agentSessionReplacedRuntimes(
  state: AgentSessionStoreState,
  args: { hostId: string; incarnation: string }
): ReadonlyMap<string, AgentSessionReplacedRuntime> {
  const replaced = new KeptWriterAwareReplacedRuntimes()
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
      ...(owner?.runtime ? { runtime: owner.runtime } : {}),
      ...(owner ? { lastProvenAliveAt: lease.lastRenewedAt } : {}),
      ...(runtimeEnd ? { runtimeEnd } : {})
    })
  }
  return replaced
}
