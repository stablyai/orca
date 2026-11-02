// What this runtime took over from the Orca runtimes that ran chats on this state directory before
// it. It loaded their records holding the profile's instance lock, so none of them is still running:
// every provider they started lost its pipes with them, and nothing it did after can reach the chat.
// That is the execution host's own proof that a turn those runtimes left running is over, whether or
// not the provider process itself can still be proven gone.

import type { AgentSessionOrcaStopCause } from '../../shared/agent-session-orca-stop'
import type { AgentSessionStoreState } from './agent-session-store-state'

export type AgentSessionReplacedRuntime = {
  /** The highest fence a replaced runtime granted; every lower fence was granted before it. */
  fence: number
  /** The last renewal of the owner loaded at `fence`, its last proof of life. */
  lastProvenAliveAt?: number
  /** How the runtime holding the owner loaded at `fence` ended, when its record says. */
  runtimeEnd?: AgentSessionOrcaStopCause
}

/** One entry per chat whose fences were all granted by runtimes this one replaced. */
export function agentSessionReplacedRuntimes(
  state: AgentSessionStoreState,
  args: { hostId: string; incarnation: string }
): ReadonlyMap<string, AgentSessionReplacedRuntime> {
  const replaced = new Map<string, AgentSessionReplacedRuntime>()
  for (const [sessionId, { lease }] of state.records) {
    const owner = lease.ownerProcess
    // A terminal's own agent never wrote through Orca's pipes; another host's runtime is not one this
    // replaced; and an owner this runtime recorded (a host reinstalled in one process) may still be held.
    if (
      lease.claimStatus === 'conflicted' ||
      (owner && (owner.hostId !== args.hostId || owner.runtime === args.incarnation))
    ) {
      continue
    }
    const runtimeEnd = owner?.runtime ? state.runtimeEnds?.get(owner.runtime) : undefined
    replaced.set(sessionId, {
      fence: lease.runtimeFence,
      ...(owner ? { lastProvenAliveAt: lease.lastRenewedAt } : {}),
      ...(runtimeEnd ? { runtimeEnd } : {})
    })
  }
  return replaced
}
