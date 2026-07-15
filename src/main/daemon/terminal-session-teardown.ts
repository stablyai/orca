import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { Session } from './session'

type AgentTeardownOperation = {
  promise: Promise<void>
  immediate: boolean
  rootSignalled: boolean
  rootCompletion: Promise<void>
  session: Session
}

/** Owns agent teardown by session id until descendant capture and root
 * signalling finish, even when the root exits and its Session is reaped. */
export class TerminalSessionTeardown {
  private operations = new Map<string, AgentTeardownOperation>()

  constructor(private sessions: ReadonlyMap<string, Session>) {}

  get(sessionId: string): Promise<void> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  requestImmediate(sessionId: string): Promise<void> | undefined {
    const pending = this.operations.get(sessionId)
    if (pending) {
      pending.immediate = true
      if (pending.rootSignalled && pending.session.isAlive) {
        // Why: the snapshot callback may have already sent the graceful root
        // signal in this turn; an immediate join must still escalate and wait.
        pending.rootCompletion = pending.session.forceKillAndWaitForExit()
      }
    }
    return pending?.promise
  }

  killSession(sessionId: string, session: Session, immediate: boolean): void | Promise<void> {
    if (session.launchAgent) {
      return this.killAgentSession(sessionId, session, immediate)
    }
    if (immediate) {
      return session.forceKillAndWaitForExit()
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
        return session.forceKillAndWaitForExit()
      }
      return
    }
    if (!immediate) {
      session.scheduleForceDisposeFallback()
    }

    const entry: AgentTeardownOperation = {
      promise: Promise.resolve(),
      immediate,
      rootSignalled: false,
      rootCompletion: Promise.resolve(),
      session
    }
    const sweep = Promise.resolve(
      killWithDescendantSweep(
        session.pid,
        () => {
          // Why: natural exit reaps the PID while ps is running. Never signal that
          // stale numeric PID after the Session no longer represents a live root.
          if (!session.isAlive) {
            return
          }
          entry.rootSignalled = true
          if (entry.immediate) {
            entry.rootCompletion = session.forceKillAndWaitForExit()
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
    // Why: descendant capture completion only proves signals were requested;
    // destructive callers must retain the native owner until OS-confirmed exit.
    const operation = sweep.then(() => entry.rootCompletion)
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
}
