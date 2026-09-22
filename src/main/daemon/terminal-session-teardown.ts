import { reapDescendantTree } from '../pty-descendant-tree-reap'
import { SessionDescendantReapError } from './daemon-errors'
import type { Session } from './session'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'

type TeardownOperation = {
  promise: Promise<void>
  immediate: boolean
  rootSignalled: boolean
  rootCompletion: Promise<void>
  session: Session
}

/** Owns teardown by session id until descendant capture, root signalling, and
 * descendant-exit proof finish — even when the root exits and would otherwise
 * be reaped before the tree is proven gone. */
export class TerminalSessionTeardown {
  private operations = new Map<string, TeardownOperation>()

  constructor(
    private sessions: ReadonlyMap<string, Session>,
    private onTreeExited?: (sessionId: string) => void
  ) {}

  get(sessionId: string): Promise<void> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  /** Resolves once this id's tracked teardown has released the process — a rejected teardown
   *  released it too. Callers re-read session state afterwards and decide for themselves. */
  async settle(sessionId: string): Promise<void> {
    await this.operations.get(sessionId)?.promise.catch(() => {})
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
      session
    }
    // Publish before run(): killRoot may exit the session synchronously, and
    // reapSession must see this operation so it defers (#21953).
    this.operations.set(sessionId, entry)
    const operation = run(entry)
    // Clear before onTreeExited so a deferred reapSession is not blocked by this entry.
    entry.promise = operation.then(
      () => {
        if (this.operations.get(sessionId) === entry) {
          this.operations.delete(sessionId)
        }
        this.onTreeExited?.(sessionId)
      },
      (error) => {
        if (this.operations.get(sessionId) === entry) {
          this.operations.delete(sessionId)
        }
        throw error
      }
    )
    return entry.promise
  }

  /** Immediate close must reach detached tools even when startup did not identify an agent. */
  private async forceKillPlainShellSession(sessionId: string, session: Session): Promise<void> {
    session.beginTermination()
    let rootCompletion: Promise<void> | null = null
    const verdict = await reapDescendantTree(
      session.pid,
      () => {
        // Why during verification: a stopped parent can leave identity-matched
        // zombie rows that block an exited verdict until the root is gone.
        rootCompletion = session.forceKillAndWaitForExit()
      },
      {
        ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
        terminateOwnedTree: () => session.terminateOwnedTree()
      }
    )
    // Join physical exit even when a test double skips killRoot — production
    // reapDescendantTree always invokes it, and immediate close must not return
    // before the root is gone or the wait times out.
    await (rootCompletion ?? session.forceKillAndWaitForExit())
    this.assertTreeReaped(sessionId, session, verdict)
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
        reapDescendantTree(
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
            terminateOwnedTree: () => session.terminateOwnedTree()
          }
        )
      )
      // Why: destructive callers must retain the native owner until OS-confirmed
      // root exit AND a descendant-tree verdict of exited (#21953).
      return sweep.then(async (verdict) => {
        await entry.rootCompletion
        this.assertTreeReaped(sessionId, session, verdict)
      })
    })
  }

  private assertTreeReaped(
    sessionId: string,
    session: Session,
    verdict: DescendantTreeVerdict
  ): void {
    if (verdict === 'exited') {
      session.failedToReap = null
      return
    }
    session.failedToReap = verdict
    throw new SessionDescendantReapError(sessionId, verdict)
  }
}
