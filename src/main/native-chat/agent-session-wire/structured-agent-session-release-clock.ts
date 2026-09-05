// The delay between "nothing holds this session" and "stop its provider child".
//
// TWO reasons it is not immediate. A surface that reconnects — a mobile socket dropping on a
// network switch, a renderer remounting a tab — releases and re-holds within a second, and killing
// an app-server in that window costs the user a respawn plus a resume for nothing. And a turn the
// user already asked for must finish: the provider is mid-answer, the journal has an open turn
// marker, and stopping the child there strands both.
//
// So the clock arms when the last holder leaves, and a tick that finds a turn still running RE-ARMS
// instead of evicting. That is what makes the wait start at the later of the two events rather than
// at whichever came first.

export const STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS = 15_000

export type StructuredAgentSessionReleaseClockDeps = {
  /** Never evict mid-turn; a true answer re-arms the clock instead. */
  isTurnActive: (sessionId: string) => boolean
  /** Re-checked at fire time: a holder may have arrived while the timer ran. */
  isHeld: (sessionId: string) => boolean
  evict: (sessionId: string) => Promise<void>
  onError?: (input: { sessionId: string; error: unknown }) => void
  graceMs?: number
}

export class StructuredAgentSessionReleaseClock {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly graceMs: number

  constructor(private readonly deps: StructuredAgentSessionReleaseClockDeps) {
    this.graceMs = deps.graceMs ?? STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS
  }

  arm(sessionId: string): void {
    this.cancel(sessionId)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      this.fire(sessionId)
    }, this.graceMs)
    // A pending release must never be the reason a process stays alive at quit.
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
  }

  isArmed(sessionId: string): boolean {
    return this.timers.has(sessionId)
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private fire(sessionId: string): void {
    if (this.deps.isHeld(sessionId)) {
      return
    }
    if (this.deps.isTurnActive(sessionId)) {
      this.arm(sessionId)
      return
    }
    void this.deps.evict(sessionId).catch((error: unknown) => {
      this.deps.onError?.({ sessionId, error })
    })
  }
}
