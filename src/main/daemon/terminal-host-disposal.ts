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
  pendingCreations: ReadonlyMap<string, Promise<void>>
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
    await Promise.all(pendingCreations.values())
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
