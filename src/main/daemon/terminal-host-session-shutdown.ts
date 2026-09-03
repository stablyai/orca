import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import { runWslGuestTreeKill } from './wsl-guest-tree-kill'

/**
 * Bound for one session's descendant sweep at daemon shutdown. Fits inside
 * daemon-entry's SHUTDOWN_TIMEOUT_MS with headroom for checkpoints: the
 * sweep's killRoot fires by this deadline and only the escalation wait is
 * cut, never the kill itself.
 */
const DAEMON_SWEEP_TIMEOUT_MS = 4_000

/**
 * Guest-side tree kill for a WSL agent session. Null when there is no guest
 * tree to name (non-WSL, or spawned before the marker existed) — the
 * Windows-side sweep then runs alone, as before.
 */
function startWslGuestTreeKill(session: Session): Promise<void> | null {
  if (process.platform !== 'win32') {
    return null
  }
  const { wslDistro } = session
  const ptyTreeId = session.spawnIdentity?.ptyTreeId
  if (!wslDistro || !ptyTreeId) {
    return null
  }
  return runWslGuestTreeKill({ distro: wslDistro, treeId: ptyTreeId })
}

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
        // SIGTERM-ignoring children alive. The sweep below carries an
        // explicit DAEMON_SWEEP_TIMEOUT_MS bound, so the wait cannot exceed
        // the daemon's shutdown budget either.
        let forceKillPromise: Promise<void> = Promise.resolve()
        const sweepSettled = killWithDescendantSweep(
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
            expectedRootCreationTimeMs: session.spawnIdentity?.rootCreationTimeMs,
            sweepTimeoutMs: DAEMON_SWEEP_TIMEOUT_MS,
            awaitEscalation: true
          }
        )
        // Why concurrent, not sequential: the guest kill uses a fresh wsl.exe
        // client, so the Windows-side sweep tearing down this session's own
        // wsl.exe cannot disturb it — and sequential timeouts would stack
        // past the daemon's shutdown budget. Both sides are bounded, so the
        // slower one, not the sum, decides the cost.
        await Promise.all([sweepSettled, startWslGuestTreeKill(session)])
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
