import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'

type Emit = (event: AgentSessionSubscribeEvent) => void
const readers = new WeakSet<Emit>()

/** Keep independent feature negotiation on the existing subscription lifetime. */
export function settledBodySubscriberEmit(emit: Emit, supported: boolean): Emit {
  if (!supported) {
    return emit
  }
  const scoped: Emit = (event) => emit(event)
  readers.add(scoped)
  return scoped
}

export function subscriberReadsSettledBodies(emit: Emit | undefined): boolean {
  return emit !== undefined && readers.has(emit)
}
