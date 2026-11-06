import { SessionNotFoundError } from '../protocol/daemon-errors'
import type { KillRequest } from '../protocol/daemon-rpc-contract'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { DaemonFileLog } from '../observability/daemon-file-log'

export async function handleDaemonTerminalKill(
  clientId: string,
  payload: KillRequest['payload'],
  deps: {
    host: TerminalHost
    preparations: DaemonPtySpawnPreparations
    attachments: DaemonSessionAttachments
    log: DaemonFileLog
  }
): Promise<Record<string, never>> {
  const { sessionId, immediate } = payload
  const canceledPendingSpawn = deps.preparations.cancel(sessionId)
  deps.attachments.clearInput(sessionId)
  const attribution = { sessionId, immediate: immediate === true, clientId }
  try {
    await deps.host.kill(sessionId, { immediate })
  } catch (error) {
    if (!(canceledPendingSpawn && error instanceof SessionNotFoundError)) {
      deps.log.log('session-kill-failed', {
        ...attribution,
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
  deps.log.log('session-killed', attribution)
  return {}
}
