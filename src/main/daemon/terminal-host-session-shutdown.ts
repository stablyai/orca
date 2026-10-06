import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'
import { runWslGuestTreeKill } from './wsl-guest-tree-kill'

// Leave room for checkpoints and physical root exit within the daemon shutdown budget.
const DAEMON_WINDOWS_SWEEP_TIMEOUT_MS = 4_000

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

async function disposeLiveSession(session: Session): Promise<void> {
  if (!session.beginTermination() && !session.isAlive) {
    await session.forceKillAndDisposeSubprocess()
    return
  }
  try {
    const sweep = killWithDescendantSweep(session.pid, () => {}, {
      ownsRoot: () => session.isAlive,
      terminateOwnedTree: () => session.terminateOwnedTree(),
      expectedRootCreationTimeMs: session.spawnIdentity?.rootCreationTimeMs,
      sweepTimeoutMs: process.platform === 'win32' ? DAEMON_WINDOWS_SWEEP_TIMEOUT_MS : undefined,
      terminateDescendants: terminateShutdownDescendants,
      awaitEscalation: true
    })
    // The guest kill has its own wsl.exe client; concurrent cleanup avoids stacking deadlines.
    await Promise.all([sweep, startWslGuestTreeKill(session)])
  } finally {
    await session.forceKillAndDisposeSubprocess()
  }
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

async function disposeTerminalHostSessions(
  sessions: Iterable<Session>,
  isAlreadyTracked?: (session: Session) => boolean
): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions].map(async (session) => {
      session.detachAllClients()
      if (isAlreadyTracked?.(session)) {
        // A tracked host-side close does not reach the WSL guest tree.
        await startWslGuestTreeKill(session)
        return
      }
      // Why: live children retain native ownership until physical exit, while
      // exited children must release handles without signalling a recycled pid.
      if (session.isAlive) {
        await disposeLiveSession(session)
      } else {
        session.disposeSubprocess()
      }
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
  ) => void,
  isAlreadyTracked?: (session: Session) => boolean
): Promise<void> {
  checkpointTerminalHostSessions(sessions, onFinalCheckpoint)
  await disposeTerminalHostSessions(sessions.values(), isAlreadyTracked)
  sessions.clear()
}
