// Who WANTS this session alive, as a set of ids rather than a count.
//
// A refcount is the obvious shape and the wrong one. Every path that decrements it — a chat tab
// closing, a transport dying, a client retrying a release it already sent — can fire twice or not
// at all, and an integer cannot tell those apart: a duplicate release evicts a session somebody is
// still looking at, and a lost one leaks the child forever. A set answers both idempotently,
// because it records WHICH surface holds the session, not how many do.

type Holder = { resumeCapable: boolean; incarnation: symbol }

export class StructuredAgentSessionHolders {
  private readonly bySession = new Map<string, Map<string, Holder>>()

  /** True when the session gained its FIRST holder — the edge that ends a pending release. */
  add(sessionId: string, holderId: string, resumeCapable = true): boolean {
    const holders = this.bySession.get(sessionId)
    if (!holders) {
      this.bySession.set(sessionId, new Map([[holderId, { resumeCapable, incarnation: Symbol() }]]))
      return true
    }
    const previous = holders.get(holderId)
    holders.set(holderId, {
      resumeCapable: (previous?.resumeCapable ?? false) || resumeCapable,
      incarnation: previous?.incarnation ?? Symbol()
    })
    return false
  }

  /** True when the session lost its LAST holder — the edge that starts one. */
  remove(sessionId: string, holderId: string, expectedIncarnation?: symbol): boolean {
    const holders = this.bySession.get(sessionId)
    if (
      expectedIncarnation !== undefined &&
      holders?.get(holderId)?.incarnation !== expectedIncarnation
    ) {
      return false
    }
    if (!holders?.delete(holderId) || holders.size > 0) {
      return false
    }
    this.bySession.delete(sessionId)
    return true
  }

  isHeld(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0
  }

  has(sessionId: string, holderId: string): boolean {
    return this.bySession.get(sessionId)?.has(holderId) ?? false
  }

  incarnation(sessionId: string, holderId: string): symbol | undefined {
    return this.bySession.get(sessionId)?.get(holderId)?.incarnation
  }

  holderIds(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId)?.keys() ?? [])]
  }

  hasResumeCapableHolder(sessionId: string): boolean {
    return [...(this.bySession.get(sessionId)?.values() ?? [])].some(
      (holder) => holder.resumeCapable
    )
  }

  /** Drops every holder of one session without evaluating the edge, for a session that is gone. */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
