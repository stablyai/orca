import { killWithDescendantSweep } from '../pty-descendant-termination'
import {
  sweepSessionFromSnapshot,
  sweepTerminalSessionDescendants
} from './terminal-session-descendant-sweep'
import { markPtySessionRootExited } from '../pty-session-identity'
import type { Session } from './session'

type TeardownOperation = {
  promise: Promise<void>
  immediate: boolean
  rootSignalled: boolean
  rootCompletion: Promise<void>
  session: Session
  descendantVerification: Promise<unknown> | null
  immediatePromise: Promise<void> | null
}

/** Owns teardown by session id until descendant capture and root signalling
 * finish, even when the root exits and its Session is reaped. */
export class TerminalSessionTeardown {
  private operations = new Map<string, TeardownOperation>()
  /** Why not an `operations` entry: a natural exit frees the id immediately, and a
   *  create landing on it must not queue behind a sweep of the previous session. */
  private exitSweeps = new Set<Promise<unknown>>()

  constructor(private sessions: ReadonlyMap<string, Session>) {}

  get(sessionId: string): Promise<void> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  /** Resolves once this id's tracked teardown has released the process — a rejected teardown
   *  released it too. Callers re-read session state afterwards and decide for themselves. */
  async settle(sessionId: string): Promise<void> {
    const operation = this.operations.get(sessionId)
    if (operation) {
      await this.waitForOperation(operation)
    }
  }

  isTracked(session: Session): boolean {
    return [...this.operations.values()].some((operation) => operation.session === session)
  }

  requestImmediateAll(): Promise<void>[] {
    return [...this.operations.keys()].flatMap((sessionId) => {
      const pending = this.requestImmediate(sessionId)
      return pending ? [pending] : []
    })
  }

  private async waitForOperation(operation: TeardownOperation): Promise<void> {
    await operation.promise.catch(() => {})
    await operation.descendantVerification?.catch(() => {})
    await operation.rootCompletion.catch(() => {})
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
    if (!pending) {
      return undefined
    }
    pending.immediatePromise ??= this.settle(sessionId)
    return pending.immediatePromise
  }

  async requestImmediateAndSettleAll(): Promise<void> {
    await Promise.all(this.requestImmediateAll())
  }

  /**
   * Sweeps a session whose root exited on its own.
   *
   * Nothing signalled that root, so nothing signalled what it left behind: a
   * descendant that had already reparented to pid 1, or that sits outside the
   * terminal's foreground group, never receives the kernel's hang-up either. The
   * session's recorded identity is what still names that work (#22346).
   */
  sweepExitedSession(sessionId: string, session: Session): void {
    if (this.operations.has(sessionId)) {
      // A tracked teardown already owns this session's descendants.
      return
    }
    // Closes the window in which this session could still have gained members on
    // its terminal, so a later tty match cannot be a new session's process.
    markPtySessionRootExited(session.processIdentity)
    const sweep = sweepTerminalSessionDescendants(session.processIdentity).catch(() => {})
    this.exitSweeps.add(sweep)
    void sweep.finally(() => this.exitSweeps.delete(sweep))
  }

  /** Lets daemon shutdown wait out sweeps started by sessions that exited on their own. */
  async settleExitSweeps(): Promise<void> {
    await Promise.all(this.exitSweeps)
  }

  killSession(sessionId: string, session: Session, immediate: boolean): void | Promise<void> {
    if (session.launchAgent) {
      return this.killAgentSession(sessionId, session, immediate)
    }
    if (immediate) {
      // Why tracked like the agent path: this claims termination on the Session and then awaits
      // an OS probe and taskkill, and a create landing inside that window must be able to wait it
      // out rather than be told the id is absent (#18046).
      return this.track(sessionId, session, immediate, () =>
        this.forceKillPlainShellSession(sessionId, session)
      )
    }
    session.kill()
  }

  /** Publishes an operation for `sessionId` and retires it once the teardown settles. */
  private track(
    sessionId: string,
    session: Session,
    immediate: boolean,
    run: (entry: TeardownOperation) => Promise<void>
  ): Promise<void> {
    const entry: TeardownOperation = {
      promise: Promise.resolve(),
      immediate,
      rootSignalled: false,
      rootCompletion: Promise.resolve(),
      session,
      descendantVerification: null,
      immediatePromise: null
    }
    const operation = run(entry)
    entry.promise = operation
    this.operations.set(sessionId, entry)
    const clearOperation = (): void => {
      if (this.operations.get(sessionId) === entry) {
        this.operations.delete(sessionId)
      }
    }
    const settleOperation = (): void => {
      void this.waitForOperation(entry).then(clearOperation, clearOperation)
    }
    void operation.then(settleOperation, settleOperation)
    return operation
  }

  /** Immediate close must reach detached tools even when startup did not identify an agent. */
  private async forceKillPlainShellSession(sessionId: string, session: Session): Promise<void> {
    session.beginTermination()
    await killWithDescendantSweep(session.pid, () => {}, {
      ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
      terminateOwnedTree: () => session.terminateOwnedTree(),
      terminateDescendants: (snapshot) =>
        sweepSessionFromSnapshot(session.processIdentity, snapshot),
      awaitEscalation: true
    })
    await session.forceKillAndWaitForExit()
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

    return this.track(sessionId, session, immediate, (entry) => {
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
            ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
            terminateOwnedTree: () => session.terminateOwnedTree(),
            terminateDescendants: (snapshot) => {
              entry.descendantVerification = sweepSessionFromSnapshot(
                session.processIdentity,
                snapshot
              )
              return entry.descendantVerification
            },
            awaitEscalation: () => entry.immediate
          }
        )
      )
      // Why: descendant capture completion only proves signals were requested;
      // destructive callers must retain the native owner until OS-confirmed exit.
      return sweep.then(() => entry.rootCompletion)
    })
  }
}
