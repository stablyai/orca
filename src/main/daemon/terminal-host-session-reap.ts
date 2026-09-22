import type { Session } from './session'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalHostTombstones } from './terminal-host-tombstones'

/** Kill a live session and return the teardown-tracked promise for coalescing. */
export function killTerminalHostSession(
  sessionId: string,
  opts: { immediate?: boolean },
  deps: {
    sessionTeardown: TerminalSessionTeardown
    killedTombstones: TerminalHostTombstones
    getAliveSession: (sessionId: string) => Session
  }
): Promise<void> {
  const pending = deps.sessionTeardown.get(sessionId)
  if (pending) {
    return Promise.resolve(
      opts.immediate ? deps.sessionTeardown.requestImmediate(sessionId) : pending
    )
  }
  const session = deps.getAliveSession(sessionId)
  const killed = deps.sessionTeardown.killSession(sessionId, session, opts.immediate === true)
  deps.killedTombstones.record(sessionId)
  return Promise.resolve(deps.sessionTeardown.get(sessionId) ?? killed)
}

/** Drop a dead session once teardown has proven its descendant tree exited. */
export function reapTerminalHostSession(
  sessionId: string,
  deps: {
    sessions: Map<string, Session>
    sessionTeardown: TerminalSessionTeardown
    onSessionReaped?: (sessionId: string) => void
  }
): void {
  const session = deps.sessions.get(sessionId)
  if (!session || session.isAlive) {
    return
  }
  if (deps.sessionTeardown.get(sessionId) || session.failedToReap) {
    return
  }
  session.dispose()
  deps.sessions.delete(sessionId)
  deps.onSessionReaped?.(sessionId)
}
