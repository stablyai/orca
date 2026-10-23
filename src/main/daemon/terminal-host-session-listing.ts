import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { Session } from './session'
import type { SessionInfo } from './types'

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
    const foregroundProcess = session.getForegroundProcess({ cachedOnly: true })
    result.push({
      sessionId: session.sessionId,
      ...(foregroundProcess ? { foregroundProcess } : {}),
      incarnationId: session.incarnationId,
      // Why: a session whose kill was accepted is still live but no longer restorable; readers that
      // adopt or restore sessions must skip it, while liveness readers keep counting it.
      state: session.isTerminating ? 'exiting' : session.state,
      shellState: session.shellState,
      isAlive: true,
      ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
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

export function hasLiveTerminalHostSessions(sessions: ReadonlyMap<string, Session>): boolean {
  let hasLive = false
  // Read every Session to preserve inventory error order.
  for (const session of sessions.values()) {
    hasLive = session.isAlive || hasLive
  }
  return hasLive
}
