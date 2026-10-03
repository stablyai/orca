import { readAgentProcessIdentity } from '../../shared/agent-process-presence'
import type { TerminalHost } from './terminal-host'
import type { GetForegroundProcessRequest } from './daemon-foreground-process-protocol'

export async function readDaemonForeground(
  host: Pick<TerminalHost, 'probeAgentPresence' | 'captureAgentPresence' | 'getForegroundProcess'>,
  payload: GetForegroundProcessRequest['payload']
) {
  if (payload.probeAgentPresence) {
    const identity = readAgentProcessIdentity(payload.probeAgentPresence)
    return {
      agentPresenceVerdict: identity
        ? await host.probeAgentPresence(payload.sessionId, identity)
        : 'unverifiable'
    }
  }
  if (payload.captureAgentPresence) {
    return {
      agentPresence: await host.captureAgentPresence(
        payload.sessionId,
        typeof payload.snapshotNotBeforeMs === 'number' &&
          Number.isFinite(payload.snapshotNotBeforeMs)
          ? { snapshotNotBeforeMs: payload.snapshotNotBeforeMs }
          : undefined
      )
    }
  }
  return {
    foregroundProcess: host.getForegroundProcess(payload.sessionId)
  }
}
