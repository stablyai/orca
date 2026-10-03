import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { Session } from './session'
import type { SessionInfo } from './types'

// Why here and not on Session: only the listing reads it, and Session is at its max-lines cap.
const spawnPaneKeys = new WeakMap<Session, string>()

/** Records the ORCA_PANE_KEY a session was spawned with; reattaching never rewrites it. */
export function recordSessionSpawnPaneKey(session: Session, paneKey: string | undefined): void {
  if (paneKey) {
    spawnPaneKeys.set(session, paneKey)
  }
}

export function listLiveTerminalHostSessions(
  sessions: ReadonlyMap<string, Session>,
  agentSessionOwners: ClaimedAgentPtyOwnerRegistry
): SessionInfo[] {
  const result: SessionInfo[] = []
  for (const session of sessions.values()) {
    if (!session.isAlive) {
      continue
    }
    const size = session.getAppliedSize()
    const paneKey = spawnPaneKeys.get(session)
    result.push({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      state: session.state,
      shellState: session.shellState,
      isAlive: true,
      ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
      ...(paneKey ? { paneKey } : {}),
      wslDistro: session.wslDistro,
      pid: session.pid,
      cwd: session.getCwd(),
      cols: size?.cols ?? 0,
      rows: size?.rows ?? 0,
      createdAt: 0,
      agentSessionOwners: agentSessionOwners.listForPty(session.sessionId)
    })
  }
  return result
}
