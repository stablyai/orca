// The delay between "nothing holds this session and nothing has happened in it" and "stop its
// provider child".
//
// It is an IDLE window, not a short grace. A surface that reconnects — a mobile socket dropping on
// a network switch, a renderer remounting a tab, a worktree switch hiding the pane — releases and
// re-holds, and a send to a chat nobody is looking at restarts its owner; stopping the child soon
// after either costs the user a respawn plus a resume on the next message. And a turn the user
// already asked for must finish: stopping the child mid-answer strands the open turn marker.
//
// So the clock arms when the last holder leaves, every journal write while it is armed starts it
// again, and a tick that finds work still owed — a turn running, a message sent but not yet
// taken by the provider, or a subagent, command or monitor still running — re-arms instead of
// evicting. The child goes only after a full window
// with no holder and no owed work. Quit still stops every child at once.

export const STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS = 30 * 60_000

export type StructuredAgentSessionReleaseClockDeps = {
  /** Never evict while work is owed; a true answer re-arms the clock instead. */
  hasOwedWork: (sessionId: string) => boolean
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

  /** Activity in an unheld session: the idle window starts over. */
  renew(sessionId: string): void {
    if (this.timers.has(sessionId)) {
      this.arm(sessionId)
    }
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
    if (this.deps.hasOwedWork(sessionId)) {
      this.arm(sessionId)
      return
    }
    void this.deps.evict(sessionId).catch((error: unknown) => {
      this.deps.onError?.({ sessionId, error })
    })
  }
}
