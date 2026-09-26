// The lifetime of a structured session, tied to the surfaces that want one.
//
// Nothing used to tell the host that a chat WANTED a session, and nothing told it when a chat
// stopped wanting one. Both halves of that gap cost real processes: sessions nobody had opened got
// an app-server at every launch, and sessions the user closed kept theirs until the app quit.
//
// A surface takes a hold when it binds and drops it when it goes away. The first hold on a session
// with no child resumes it — that, and not the shape of a lease on disk, is what makes a provider
// process exist. The last hold leaving starts the idle release clock. Transport close is the BACKSTOP,
// not the mechanism: a client that vanishes mid-flight never sends its release, so the caller
// registers one against the connection and the holder set absorbs the duplicate.
//
// A send to a childless session resumes it too, and so does provider-exit recovery under an open
// surface. All three go through `ensureProviderChild` inside the session's serialize, so they take
// turns: the first to run attaches, and the next finds the child and attaches nothing. Two attaches
// for one session would race against the same released fence, and the loser's stale fence refused
// it — a hold that lost dropped its holder, a send that lost was refused.

import { AgentSessionRefusalError, refuse } from '../../../shared/agent-session-wire-refusals'
import {
  StructuredAgentSessionReleaseClock,
  type StructuredAgentSessionReleaseClockDeps
} from './structured-agent-session-release-clock'
import { StructuredAgentSessionHolders } from './structured-agent-session-holders'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-hold-resume'
import type { StructuredAgentSessionAttachOptions } from './structured-agent-session-attach-orchestration'

export type StructuredAgentSessionHoldsDeps = {
  /** Attaches a provider child, for a caller already inside `serialize`. */
  resume: (
    sessionId: string,
    attachOptions?: StructuredAgentSessionAttachOptions
  ) => Promise<StructuredAgentSessionResumeOutcome>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Whether evicting this session would actually free anything. */
  hasProviderChild: (sessionId: string) => boolean
  hasOwedWork: (sessionId: string) => boolean
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
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionHoldsDeps) {
    const clockDeps: StructuredAgentSessionReleaseClockDeps = {
      hasOwedWork: deps.hasOwedWork,
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
    this.holders.add(sessionId, holderId, options.resume !== false)
    const incarnation = this.holders.incarnation(sessionId, holderId)
    // Unconditional, not only on the first-holder edge: a second surface arriving during the grace
    // window must cancel the pending release too.
    this.clock.cancel(sessionId)
    if (options.resume === false) {
      return
    }
    let resumed: StructuredAgentSessionResumeOutcome
    try {
      resumed = await this.deps.serialize(sessionId, () => this.ensureProviderChild(sessionId))
    } catch (error) {
      this.releaseFailedHold(sessionId, holderId, alreadyHeld, incarnation)
      throw error
    }
    if (!resumed.ok) {
      this.releaseFailedHold(sessionId, holderId, alreadyHeld, incarnation)
      // The RPC surface raises a refusal as its code; the refusal itself rides along for its cause.
      throw new AgentSessionRefusalError(resumed.refusal)
    }
  }

  /** Only the holder this call added, at the incarnation it added: a same-ID hold that left and
   *  came back while this one waited owns the holder now, and its own attempt decides it. */
  private releaseFailedHold(
    sessionId: string,
    holderId: string,
    alreadyHeld: boolean,
    incarnation: symbol | undefined
  ): void {
    if (!alreadyHeld && incarnation !== undefined) {
      this.release(sessionId, holderId, incarnation)
    }
  }

  /**
   * Gives the session a provider child if it has none.
   *
   * For a caller already inside the session's serialize, which is what makes "if it has none"
   * exact: a hold and a send that both find the owner gone run this in turn, and the second sees
   * the first one's child. Each caller makes at most one attach, and a failed one leaves the
   * next caller to make its own. With no surface holding the session afterwards, the child goes
   * on the same clock a departed surface would start — including the surface that held it when
   * provider-exit recovery began and left while the attach ran.
   */
  async ensureProviderChild(
    sessionId: string,
    attachOptions?: StructuredAgentSessionAttachOptions
  ): Promise<StructuredAgentSessionResumeOutcome> {
    if (this.deps.hasProviderChild(sessionId)) {
      return { ok: true }
    }
    const resumed = await this.deps.resume(sessionId, attachOptions)
    if (!resumed.ok) {
      return resumed
    }
    if (!this.deps.hasProviderChild(sessionId)) {
      return {
        ok: false,
        refusal: refuse(
          'agent_session_ownership_unknown',
          'noProviderChild',
          'The session attached without a provider child to write to.'
        )
      }
    }
    // The last surface can disconnect before acquisition makes a child available to release.
    if (!this.disposed && !this.holders.isHeld(sessionId)) {
      this.clock.arm(sessionId)
    }
    return { ok: true }
  }

  /** Activity — a journal write, or a start reaching the work it held; only a pending release
   *  notices, and it restarts its full window. */
  renew(sessionId: string): void {
    this.clock.renew(sessionId)
  }

  release(sessionId: string, holderId: string, expectedIncarnation?: symbol): void {
    if (!this.holders.remove(sessionId, holderId, expectedIncarnation)) {
      return
    }
    if (!this.disposed && this.deps.hasProviderChild(sessionId)) {
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

  hasResumeCapableHolder(sessionId: string): boolean {
    return this.holders.hasResumeCapableHolder(sessionId)
  }

  isReleasePending(sessionId: string): boolean {
    return this.clock.isArmed(sessionId)
  }

  dispose(): void {
    this.disposed = true
    this.clock.dispose()
  }
}
