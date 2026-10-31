import type { Session } from './session'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import type { TerminalHostOptions } from './terminal-host-options'
import type { TerminalSpawnGate } from './terminal-spawn-gate'

export type TerminalHostSessionCreateDependencies = {
  sessions: Map<string, Session>
  /** Re-checks the host's shutdown fence and this request's cancellation after any await. */
  assertCreateAllowed: () => void
  sessionTeardown: TerminalSessionTeardown
  killedTombstones: TerminalHostTombstones
  spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  spawnGate: TerminalSpawnGate | undefined
  onDeadSessionRemoved: (sessionId: string) => void
  onSessionCreated: (sessionId: string, generation: string | undefined, isAlive: boolean) => void
  onSessionExit: (sessionId: string, generation: string | undefined) => void
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
}
