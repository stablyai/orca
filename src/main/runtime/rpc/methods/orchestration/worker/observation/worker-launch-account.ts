import {
  workerAccountView,
  type WorkerAccountView
} from '../../../../../orchestration/workers/worker-account-view'
import { sessionIdFromStructuredWorkerIncarnation } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { getStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** The account the host launched this worker's chat under; null when it never observed one. */
export function workerLaunchAccount(
  processIncarnation: string | null | undefined
): WorkerAccountView | null {
  const sessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
  const sessions = sessionId ? getStructuredAgentSessionHost()?.deps.store : undefined
  return workerAccountView(sessionId ? sessions?.getRecord(sessionId) : null, sessions?.hostId)
}
