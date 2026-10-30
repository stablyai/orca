import type { PendingTerminalCreation } from './terminal-creation-work'
import { shutdownTerminalHostSessions } from './terminal-host-session-shutdown'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

type FinalCheckpoint = (
  sessionId: string,
  snapshot: TerminalSnapshot,
  records: TakePendingOutputResult['records']
) => void

type TerminalHostDisposalOptions = {
  pendingCreations: ReadonlyMap<string, PendingTerminalCreation>
  sessionTeardown: TerminalSessionTeardown
  sessions: Map<string, Session>
  onFinalCheckpoint?: FinalCheckpoint
  killedTombstones: { clear: () => void }
}

export async function disposeTerminalHostSessions({
  pendingCreations,
  sessionTeardown,
  sessions,
  onFinalCheckpoint,
  killedTombstones
}: TerminalHostDisposalOptions): Promise<void> {
  if (pendingCreations.size > 0) {
    // No spawn may publish a session after teardown completes.
    await Promise.all(
      [...pendingCreations.values()].map(async (creation) => {
        await creation.recover()
        await creation.completion
      })
    )
  }
  const existingTeardowns = sessionTeardown.requestImmediateAll()
  await Promise.all([
    shutdownTerminalHostSessions(
      sessions,
      onFinalCheckpoint,
      sessionTeardown.isTracked.bind(sessionTeardown)
    ),
    ...existingTeardowns
  ])
  killedTombstones.clear()
}

/** Last resort when shutdown overruns its deadline: an async group sweep may not have signalled yet. */
export function killLiveSessionGroupsSync(sessions: Iterable<Session>): void {
  if (process.platform === 'win32') {
    return
  }
  for (const session of sessions) {
    // Exited roots are reaped, so their pids may already belong to someone else.
    if (session.isAlive) {
      killPtyRootProcessGroup(session.pid)
    }
  }
}

/** node-pty roots lead their own session and group, so -pid reaches the group without a ps lookup. */
function killPtyRootProcessGroup(rootPid: number): void {
  try {
    process.kill(-rootPid, 'SIGKILL')
    return
  } catch (error) {
    if (!isGroupKillRefused(error)) {
      return
    }
  }
  try {
    process.kill(rootPid, 'SIGKILL')
  } catch {
    // Exit can win the race with this last-resort signal.
  }
}

function isGroupKillRefused(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ESRCH' || code === 'EPERM'
}
