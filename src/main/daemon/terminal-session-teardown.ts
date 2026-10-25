import { killWithDescendantSweep } from '../pty-descendant-termination'
import { excludeShellBackgroundJobs } from '../pty-shell-job-preservation'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'
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

/** Retain teardown ownership across descendant capture, root exit, and Session reaping. */
export class TerminalSessionTeardown {
  private operations = new Map<string, TeardownOperation>()

  constructor(private sessions: ReadonlyMap<string, Session>) {}

  get(sessionId: string): Promise<void> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  /** Wait through rejected teardown work too; callers must recheck the Session’s actual liveness. */
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
        // Escalate even if the snapshot callback already sent a graceful signal in this turn.
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

  killSession(sessionId: string, session: Session, immediate: boolean): void | Promise<void> {
    if (!session.launchAgent && !immediate && process.platform === 'win32') {
      // The PTY job would also end `start /b` and GUI children, which a graceful close leaves running.
      if (session.beginTermination()) {
        session.signalTerminationRoot()
        session.scheduleForceDisposeFallback()
      }
      return
    }
    // Hand-typed agents carry no launch metadata, yet their detached tools outlive the shell's SIGHUP.
    if (session.launchAgent || !immediate) {
      return this.killAfterDescendantSnapshot(sessionId, session, immediate)
    }
    // Track the async probe so a concurrent create waits instead of treating the terminating ID as absent (#18046).
    return this.track(sessionId, session, immediate, () =>
      this.forceKillPlainShellSession(sessionId, session)
    )
  }

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
      terminateDescendants: terminateShutdownDescendants,
      awaitEscalation: true
    })
    await session.forceKillAndWaitForExit()
  }

  private killAfterDescendantSnapshot(
    sessionId: string,
    session: Session,
    immediate: boolean
  ): void | Promise<void> {
    const pending = this.operations.get(sessionId)
    if (pending) {
      // An immediate join must escalate the pending graceful request.
      pending.immediate ||= immediate
      return pending.promise
    }

    if (!session.beginTermination()) {
      // A graceful sweep may leave the root alive; escalate after its scan has finished.
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
            // Natural exit can recycle the PID during capture; signal only while this Session still owns a live root.
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
            // Captured descendants are authoritative only while this exact Session owns the live root.
            ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
            terminateOwnedTree: () => session.terminateOwnedTree(),
            terminateDescendants: (snapshot) => {
              entry.descendantVerification = terminateShutdownDescendants(
                session.launchAgent || entry.immediate
                  ? snapshot
                  : excludeShellBackgroundJobs(snapshot, session.shellIsRootChild)
              )
              return entry.descendantVerification
            },
            awaitEscalation: () => entry.immediate
          }
        )
      )
      // Requested signals do not prove exit; retain native ownership until OS-confirmed death.
      return sweep.then(() => entry.rootCompletion)
    })
  }
}
