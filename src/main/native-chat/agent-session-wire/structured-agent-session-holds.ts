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
import {
  StructuredAgentSessionHolders,
  type StructuredAgentSessionHolderRegistration
} from './structured-agent-session-holders'

export type StructuredAgentSessionHoldsDeps = {
  /** Acquires a provider child for a session that has none. A no-op when one is already live. */
  resume: (sessionId: string, isCurrent: () => boolean) => Promise<void>
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

type StructuredAgentSessionResume = {
  promise: Promise<void>
  state: { forgotten: boolean; failure?: Error }
}

type StructuredAgentSessionLifecycle = {
  holders: StructuredAgentSessionHolders
  resume?: StructuredAgentSessionResume
  eviction?: Promise<void>
  evictionFailure?: { error: unknown }
}

export type StructuredAgentSessionHolderLease = {
  isCurrent: () => boolean
}

export class StructuredAgentSessionHolds {
  private readonly sessions = new Map<string, StructuredAgentSessionLifecycle>()
  private readonly clock: StructuredAgentSessionReleaseClock
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionHoldsDeps) {
    const clockDeps: StructuredAgentSessionReleaseClockDeps = {
      isTurnActive: deps.isTurnActive,
      isHeld: (sessionId) => this.isHeld(sessionId),
      evict: (sessionId) => this.evict(sessionId),
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
    if (this.disposed) {
      throw new Error('agent_session_ownership_unknown')
    }
    const lifecycle = this.lifecycleFor(sessionId)
    const { alreadyHeld, registration } = this.addHolder(
      lifecycle,
      holderId,
      lifecycle.eviction === undefined && lifecycle.evictionFailure === undefined
    )
    // Unconditional, not only on the first-holder edge: a second surface arriving during the grace
    // window must cancel the pending release too.
    this.clock.cancel(sessionId)
    try {
      if (lifecycle.evictionFailure !== undefined && lifecycle.eviction === undefined) {
        await this.evict(sessionId)
      }
      while (lifecycle.eviction) {
        await lifecycle.eviction
      }
      if (this.disposed) {
        throw new Error('agent_session_ownership_unknown')
      }
      if (!this.isCurrentHolder(sessionId, lifecycle, holderId, registration)) {
        return
      }
      registration.active = true
      const pendingResume = lifecycle.resume
      if (
        options.resume === false ||
        (this.deps.hasProviderChild(sessionId) && pendingResume === undefined)
      ) {
        return
      }
      const resume = pendingResume ?? this.resumeSession(sessionId, lifecycle)
      await resume.promise
      if (resume.state.forgotten || !this.deps.hasProviderChild(sessionId)) {
        resume.state.failure ??= new Error('agent_session_ownership_unknown')
        throw resume.state.failure
      }
    } catch (error) {
      if (!alreadyHeld && this.isCurrentHolder(sessionId, lifecycle, holderId, registration)) {
        const lostLastHolder = this.removeHolder(lifecycle, holderId)
        if (lostLastHolder && this.deps.hasProviderChild(sessionId)) {
          this.clock.arm(sessionId)
        }
      }
      throw error
    } finally {
      this.prune(sessionId, lifecycle)
    }
  }

  release(sessionId: string, holderId: string): void {
    const lifecycle = this.sessions.get(sessionId)
    if (!lifecycle) {
      return
    }
    const lostLastHolder = this.removeHolder(lifecycle, holderId)
    if (lostLastHolder && this.deps.hasProviderChild(sessionId)) {
      this.clock.arm(sessionId)
    }
    this.prune(sessionId, lifecycle)
  }

  /** Drops the holders of a session that is gone, whoever evicted it. */
  forget(sessionId: string): void {
    this.clock.cancel(sessionId)
    const lifecycle = this.sessions.get(sessionId)
    if (!lifecycle) {
      return
    }
    lifecycle.holders.forget(lifecycle.eviction !== undefined)
    if (lifecycle.resume) {
      lifecycle.resume.state.forgotten = true
      lifecycle.resume = undefined
    }
    this.prune(sessionId, lifecycle)
  }

  isHeld(sessionId: string): boolean {
    const lifecycle = this.sessions.get(sessionId)
    return lifecycle ? this.hasActiveHolder(lifecycle) : false
  }

  holderLease(sessionId: string, holderId: string): StructuredAgentSessionHolderLease | null {
    const lifecycle = this.sessions.get(sessionId)
    const registration = lifecycle?.holders.get(holderId)
    if (!lifecycle || !registration?.active || lifecycle.eviction) {
      return null
    }
    return {
      isCurrent: () =>
        !this.disposed &&
        this.sessions.get(sessionId) === lifecycle &&
        lifecycle.eviction === undefined &&
        lifecycle.holders.isCurrent(holderId, registration)
    }
  }

  isReleasePending(sessionId: string): boolean {
    return this.clock.isArmed(sessionId)
  }

  evict(sessionId: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const lifecycle = this.lifecycleFor(sessionId)
    if (lifecycle.eviction) {
      return lifecycle.eviction
    }
    lifecycle.evictionFailure = undefined
    if (lifecycle.resume) {
      lifecycle.resume.state.forgotten = true
      lifecycle.resume = undefined
    }
    const attempt = Promise.resolve().then(() => this.deps.evict(sessionId))
    lifecycle.eviction = attempt
    void attempt.then(
      () => this.clearEviction(sessionId, lifecycle, attempt),
      (error) => {
        lifecycle.evictionFailure = { error }
        this.clearEviction(sessionId, lifecycle, attempt)
      }
    )
    return attempt
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clock.dispose()
    for (const lifecycle of this.sessions.values()) {
      if (lifecycle.resume) {
        lifecycle.resume.state.forgotten = true
      }
      lifecycle.holders.clear()
    }
    this.sessions.clear()
  }

  private lifecycleFor(sessionId: string): StructuredAgentSessionLifecycle {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      return existing
    }
    const created: StructuredAgentSessionLifecycle = {
      holders: new StructuredAgentSessionHolders()
    }
    this.sessions.set(sessionId, created)
    return created
  }

  private resumeSession(
    sessionId: string,
    lifecycle: StructuredAgentSessionLifecycle
  ): StructuredAgentSessionResume {
    if (lifecycle.resume) {
      return lifecycle.resume
    }
    const state: StructuredAgentSessionResume['state'] = { forgotten: false }
    const attempt: StructuredAgentSessionResume = {
      promise: Promise.resolve().then(async () => {
        let hasProviderChild = false
        try {
          await this.deps.resume(sessionId, () => !state.forgotten)
        } finally {
          hasProviderChild = this.deps.hasProviderChild(sessionId)
          if (!this.hasActiveHolder(lifecycle) && hasProviderChild) {
            this.clock.arm(sessionId)
          }
        }
        if (state.forgotten || !hasProviderChild) {
          state.failure ??= new Error('agent_session_ownership_unknown')
          throw state.failure
        }
      }),
      state
    }
    lifecycle.resume = attempt
    void attempt.promise.then(
      () => this.clearResume(sessionId, lifecycle, attempt),
      () => this.clearResume(sessionId, lifecycle, attempt)
    )
    return attempt
  }

  private clearResume(
    sessionId: string,
    lifecycle: StructuredAgentSessionLifecycle,
    attempt: StructuredAgentSessionResume
  ): void {
    if (lifecycle.resume === attempt) {
      lifecycle.resume = undefined
    }
    this.prune(sessionId, lifecycle)
  }

  private clearEviction(
    sessionId: string,
    lifecycle: StructuredAgentSessionLifecycle,
    attempt: Promise<void>
  ): void {
    if (lifecycle.eviction === attempt) {
      lifecycle.eviction = undefined
    }
    this.prune(sessionId, lifecycle)
  }

  private addHolder(
    lifecycle: StructuredAgentSessionLifecycle,
    holderId: string,
    active: boolean
  ): { alreadyHeld: boolean; registration: StructuredAgentSessionHolderRegistration } {
    return lifecycle.holders.add(holderId, active)
  }

  private isCurrentHolder(
    sessionId: string,
    lifecycle: StructuredAgentSessionLifecycle,
    holderId: string,
    registration: StructuredAgentSessionHolderRegistration
  ): boolean {
    return (
      this.sessions.get(sessionId) === lifecycle &&
      lifecycle.holders.isCurrent(holderId, registration)
    )
  }

  /** Removes one holder and reports whether the session lost its last holder. */
  private removeHolder(lifecycle: StructuredAgentSessionLifecycle, holderId: string): boolean {
    return lifecycle.holders.remove(holderId)
  }

  private hasActiveHolder(lifecycle: StructuredAgentSessionLifecycle): boolean {
    return lifecycle.holders.hasActive()
  }

  private prune(sessionId: string, lifecycle: StructuredAgentSessionLifecycle): void {
    if (
      this.sessions.get(sessionId) === lifecycle &&
      lifecycle.holders.size === 0 &&
      lifecycle.resume === undefined &&
      lifecycle.eviction === undefined &&
      lifecycle.evictionFailure === undefined
    ) {
      this.sessions.delete(sessionId)
    }
  }
}
