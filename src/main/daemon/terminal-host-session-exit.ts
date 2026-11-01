import {
  pruneRetiredPtyIncarnations,
  type RetiredPtyIncarnation
} from '../../shared/retired-pty-incarnations'
import type { Session } from './session'

const REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS = 2_000

/** What the host keeps of a session as it exits, before the session is reaped. */
export function recordTerminalHostSessionExit(
  sessionId: string,
  session:
    | Pick<Session, 'hasAttachedClients' | 'exitCode' | 'incarnationId' | 'wslDistro'>
    | undefined,
  retiredIncarnations: Map<string, RetiredPtyIncarnation>,
  log: ((event: string, details: Record<string, unknown>) => void) | undefined
): void {
  if (!session) {
    return
  }
  // An attached client logs `session-exited` when it hears the exit; one no client heard (a pane not
  // reopened since a relaunch, whose distro then stopped) would otherwise leave daemon.log no line.
  if (!session.hasAttachedClients) {
    log?.('session-exited', {
      sessionId,
      code: session.exitCode ?? 0,
      attached: false,
      ...(session.wslDistro ? { wslBridge: true } : {})
    })
  }
  pruneRetiredPtyIncarnations(retiredIncarnations)
  retiredIncarnations.set(sessionId, {
    incarnationId: session.incarnationId,
    code: session.exitCode ?? 0,
    expiresAt: Date.now() + REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS
  })
}
