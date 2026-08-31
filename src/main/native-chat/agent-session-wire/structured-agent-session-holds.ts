// The lifetime of a structured session, tied to the surfaces that want one.
//
// Nothing used to tell the host that a chat WANTED a session, and nothing told it when a chat
// stopped wanting one. Both halves of that gap cost real processes: sessions nobody had opened got
// an app-server at every launch, and sessions the user closed kept theirs until the app quit.
//
// A surface takes a hold when it binds and drops it when it goes away. The first hold on a session
// with no child resumes it — that, and not the shape of a lease on disk, is what makes a provider
// process exist. The last hold leaving starts the release clock. Transport close is the BACKSTOP,
// not the mechanism: a client that vanishes mid-flight never sends its release, so the caller
// registers one against the connection and the holder set absorbs the duplicate.

import {
  StructuredAgentSessionReleaseClock,
  type StructuredAgentSessionReleaseClockDeps
} from './structured-agent-session-release-clock'
import { StructuredAgentSessionHolders } from './structured-agent-session-holders'

export type StructuredAgentSessionHoldsDeps = {
  /** Acquires a provider child for a session that has none. A no-op when one is already live. */
  resume: (sessionId: string) => Promise<void>
  /** Whether evicting this session would actually free anything. */
  hasProviderChild: (sessionId: string) => boolean
  isTurnActive: (sessionId: string) => boolean
  evict: (sessionId: string) => Promise<void>
  onError?: (input: { sessionId: string; error: unknown }) => void
  graceMs?: number
}

export type StructuredAgentSessionHoldOptions = {
  /** False for a hold that only RETAINS — a subscription stream, which must not make a child
   *  exist just by reading history. */
  resume?: boolean
}

export class StructuredAgentSessionHolds {
  private readonly holders = new StructuredAgentSessionHolders()
  private readonly clock: StructuredAgentSessionReleaseClock

  constructor(private readonly deps: StructuredAgentSessionHoldsDeps) {
    const clockDeps: StructuredAgentSessionReleaseClockDeps = {
      isTurnActive: deps.isTurnActive,
      isHeld: (sessionId) => this.holders.isHeld(sessionId),
      evict: (sessionId) => this.deps.evict(sessionId),
      ...(deps.onError ? { onError: deps.onError } : {}),
      ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs })
    }
    this.clock = new StructuredAgentSessionReleaseClock(clockDeps)
  }

  async hold(
    sessionId: string,
    holderId: string,
    options: StructuredAgentSessionHoldOptions = {}
  ): Promise<void> {
    const alreadyHeld = this.holders.has(sessionId, holderId)
    this.holders.add(sessionId, holderId)
    // Unconditional, not only on the first-holder edge: a second surface arriving during the grace
    // window must cancel the pending release too.
    this.clock.cancel(sessionId)
    if (options.resume === false || this.deps.hasProviderChild(sessionId)) {
      return
    }
    try {
      await this.deps.resume(sessionId)
      if (!this.deps.hasProviderChild(sessionId)) {
        throw new Error('agent_session_ownership_unknown')
      }
    } catch (error) {
      if (!alreadyHeld) {
        this.holders.remove(sessionId, holderId)
      }
      throw error
    }
  }

  release(sessionId: string, holderId: string): void {
    if (!this.holders.remove(sessionId, holderId)) {
      return
    }
    if (this.deps.hasProviderChild(sessionId)) {
      this.clock.arm(sessionId)
    }
  }

  /** Drops the holders of a session that is gone, whoever evicted it. */
  forget(sessionId: string): void {
    this.clock.cancel(sessionId)
    this.holders.forget(sessionId)
  }

  isHeld(sessionId: string): boolean {
    return this.holders.isHeld(sessionId)
  }

  isReleasePending(sessionId: string): boolean {
    return this.clock.isArmed(sessionId)
  }

  dispose(): void {
    this.clock.dispose()
  }
}
