import { SessionNotFoundError, type SessionInfo } from './types'
import type { KillOwnedPayload } from './daemon-kill-request'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonFileLog } from './daemon-file-log'
import type { TerminalHost } from './terminal-host'

export function assertOwnedLiveSession(
  sessions: readonly SessionInfo[],
  sessionId: string,
  expectedIncarnationId: string
): void {
  const live = sessions.find((session) => session.sessionId === sessionId)
  if (!expectedIncarnationId || !live?.isAlive || live.incarnationId !== expectedIncarnationId) {
    throw new SessionNotFoundError(sessionId)
  }
}

export async function routeKillOwned(
  options: {
    host: TerminalHost
    preparations: DaemonPtySpawnPreparations
    attachments: DaemonSessionAttachments
    log: DaemonFileLog
  },
  clientId: string,
  payload: KillOwnedPayload
): Promise<Record<string, never>> {
  const { sessionId, expectedIncarnationId, immediate } = payload
  assertOwnedLiveSession(options.host.listSessions(), sessionId, expectedIncarnationId)
  const canceledPendingSpawn = options.preparations.cancel(sessionId)
  options.attachments.clearInput(sessionId)
  const attribution = { sessionId, immediate: immediate === true, clientId }
  try {
    await options.host.kill(sessionId, { immediate })
  } catch (error) {
    if (!(canceledPendingSpawn && error instanceof SessionNotFoundError)) {
      options.log.log('session-kill-failed', {
        ...attribution,
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
  options.log.log('session-killed', attribution)
  return {}
}
