import type { AgentSessionReserveRequest } from '../../runtime/agent-session/ownership/agent-session-reservation-admission'
import {
  reserveProtectedJournalSession,
  mirrorProtectedPlacement
} from './protected-journal-client'

export async function prepareProtectedFounding(request: AgentSessionReserveRequest) {
  const enrolled = await reserveProtectedJournalSession(
    request.location.workspaceId,
    request.sessionId,
    request.provider,
    request.operation.operationId
  )
  if (!enrolled) {
    return null
  }
  return async (mirror?: () => Promise<unknown>) => {
    const { launchEnv: _env, spawnToken: _spawn, ...placement } = request
    await mirrorProtectedPlacement(placement)
    await mirror?.()
  }
}
