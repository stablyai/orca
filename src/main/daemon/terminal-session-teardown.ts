import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { Session } from './session'

type AgentTeardownOperation = {
  promise: Promise<void>
  immediate: boolean
}

/** Owns agent teardown by session id until descendant capture and root
 * signalling finish, even when the root exits and its Session is reaped. */
export class TerminalSessionTeardown {
  private operations = new Map<string, AgentTeardownOperation>()

  constructor(
    private sessions: ReadonlyMap<string, Session>,
    private reapSession: (sessionId: string) => void
  ) {}

  get(sessionId: string): Promise<void> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  requestImmediate(sessionId: string): Promise<void> | undefined {
    const pending = this.operations.get(sessionId)
    if (pending) {
      pending.immediate = true
    }
    return pending?.promise
  }

  killSession(sessionId: string, session: Session, immediate: boolean): void | Promise<void> {
    if (session.launchAgent) {
      return this.killAgentSession(sessionId, session, immediate)
    }
    if (immediate) {
      this.finishImmediate(sessionId, session)
    } else {
      session.kill()
    }
  }

  private killAgentSession(
    sessionId: string,
    session: Session,
    immediate: boolean
  ): void | Promise<void> {
    const pending = this.operations.get(sessionId)
    if (pending) {
      // Why: an immediate caller is a stronger teardown request and must not
      // acknowledge a still-graceful root kill while capture is pending.
      pending.immediate ||= immediate
      return pending.promise
    }

    if (!session.beginTermination()) {
      // A completed graceful sweep can leave the root alive during its grace
      // window. Immediate teardown may safely escalate once no scan is pending.
      if (immediate && session.isAlive && session.isTerminating) {
        this.finishImmediate(sessionId, session)
      }
      return
    }
    if (!immediate) {
      session.scheduleForceDisposeFallback()
    }

    const entry: AgentTeardownOperation = {
      promise: Promise.resolve(),
      immediate
    }
    const operation = Promise.resolve(
      killWithDescendantSweep(
        session.pid,
        () => {
          // Why: natural exit reaps the PID while ps is running. Never signal that
          // stale numeric PID after the Session no longer represents a live root.
          if (!session.isAlive) {
            return
          }
          if (entry.immediate) {
            this.finishImmediate(sessionId, session)
          } else {
            session.signalTerminationRoot()
          }
        },
        {
          // Why: the descendant rows are only authoritative while this exact
          // Session still owns the root PID captured by ps.
          ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive
        }
      )
    )
    entry.promise = operation
    this.operations.set(sessionId, entry)
    const clearOperation = (): void => {
      if (this.operations.get(sessionId) === entry) {
        this.operations.delete(sessionId)
      }
    }
    void operation.then(clearOperation, clearOperation)
    return operation
  }

  private finishImmediate(sessionId: string, session: Session): void {
    // Why: the old root may exit and a new same-id Session may appear after
    // capture. Only this exact live Session is safe to force-kill and reap.
    if (this.sessions.get(sessionId) !== session || !session.isAlive) {
      return
    }
    session.forceKillAndDisposeSubprocess()
    this.reapSession(sessionId)
  }
}
