import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

function checkpointTerminalHostSessions(
  sessions: ReadonlyMap<string, Session>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
): void {
  if (!onFinalCheckpoint) {
    return
  }
  for (const [sessionId, session] of sessions) {
    if (!session.isAlive) {
      continue
    }
    const take = session.takePendingOutput(true, { teardownSnapshot: true })
    if (!take?.snapshot) {
      continue
    }
    try {
      onFinalCheckpoint(sessionId, take.snapshot, take.records)
    } catch {
      // Final checkpoints are best-effort and must not block native teardown.
    }
  }
}

async function disposeTerminalHostSessions(sessions: Iterable<Session>): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions].map(async (session) => {
      session.detachAllClients()
      // Why: live children retain native ownership until physical exit, while
      // exited children must release handles without signalling a recycled pid.
      if (!session.isAlive) {
        session.disposeSubprocess()
        return
      }
      if (session.launchAgent) {
        // Why: an agent's tool children live in a detached process group the
        // shell's own kill signal never reaches; daemon shutdown must sweep
        // them too, or a quit orphans them instead of just an interactive
        // pty.kill (mirrors SessionTerminationController.kill()'s sweep).
        // The snapshot must finish before the root is force-killed below: once
        // it exits, surviving descendants reparent to pid 1 and are lost.
        // killRoot force-kills the root right away, so a daemon quit cannot
        // leave it alive for the grace window below — it must not wait on
        // forceKillPromise itself. awaitEscalation instead delays this
        // function's own return: the daemon process exits right after
        // shutdown resolves, which would otherwise drop the grace-window
        // SIGKILL escalation's unref'd timer mid-flight and leave
        // SIGTERM-ignoring children alive (bounded to ~DESCENDANT_KILL_GRACE_MS
        // + DESCENDANT_SNAPSHOT_TIMEOUT_MS, well inside daemon-entry's
        // SHUTDOWN_TIMEOUT_MS).
        let forceKillPromise: Promise<void> = Promise.resolve()
        await killWithDescendantSweep(
          session.pid,
          () => {
            forceKillPromise = session.forceKillAndDisposeSubprocess()
            // Why: killWithDescendantSweep may not await the sweep's own
            // return until after the grace window; attach a handler now so a
            // rejection there can't surface as unhandled before the await below.
            forceKillPromise.catch(() => {})
          },
          {
            ownsRoot: () => session.isAlive,
            terminateOwnedTree: () => session.terminateOwnedTree(),
            awaitEscalation: true
          }
        )
        await forceKillPromise
        return
      }
      await session.forceKillAndDisposeSubprocess()
    })
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (rejected) {
    throw rejected.reason
  }
}

export async function shutdownTerminalHostSessions(
  sessions: Map<string, Session>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
): Promise<void> {
  checkpointTerminalHostSessions(sessions, onFinalCheckpoint)
  await disposeTerminalHostSessions(sessions.values())
  sessions.clear()
}
