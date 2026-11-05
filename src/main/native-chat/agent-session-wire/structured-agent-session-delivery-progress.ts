import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import type { StructuredAgentSessionStartFlight } from './structured-agent-session-start-flight'

function sample(sessionId: string, reads: StructuredAgentSessionDeliveryLoopDeps, wakes: number) {
  const session = reads.sessions.get(sessionId)
  const child = session?.child
  return {
    journal: session?.journal.cursor(),
    child: [child?.generation, child?.fence, child?.phase, child?.close !== undefined] as const,
    wakes
  }
}

function transition<T>(witness: T) {
  return { kind: 'transition', witness } as const
}

/** Owned by one active run; each serialized decision consumes every preceding iteration fact. */
export class DeliveryProgress {
  private wakes = 0
  private before?: ReturnType<typeof sample>
  // The loop decides again only after awaiting this joined claim, so it has settled by then.
  private joined?: StructuredAgentSessionStartFlight

  woke(): void {
    this.wakes += 1
  }

  /** Read any existing flight before this step can register its own; only a joined claim proves startup. */
  claim(sessionId: string, reads: StructuredAgentSessionDeliveryLoopDeps, startedFor: string) {
    const flight = reads.startFlights?.get(sessionId)
    const claim = reads.startProviderChild(sessionId, startedFor)
    this.joined = flight?.outcome === claim.outcome ? flight : undefined
    return claim
  }

  decide(sessionId: string, reads: StructuredAgentSessionDeliveryLoopDeps) {
    const now = sample(sessionId, reads, this.wakes)
    const before = this.before
    const joined = this.joined
    this.before = now
    this.joined = undefined
    if (!before) {
      return { kind: 'initial' } as const
    }
    if (
      before.journal?.epoch !== now.journal?.epoch ||
      before.journal?.sequence !== now.journal?.sequence
    ) {
      return transition({ kind: 'journal', before, now } as const)
    }
    if (before.child.some((value, index) => value !== now.child[index])) {
      return transition({ kind: 'child', before, now } as const)
    }
    if (joined && reads.startFlights?.get(sessionId) !== joined) {
      return transition({ kind: 'startup', flight: joined } as const)
    }
    if (before.wakes !== now.wakes) {
      return transition({ kind: 'wake', before: before.wakes, after: now.wakes } as const)
    }
    return { kind: 'park' } as const
  }
}
