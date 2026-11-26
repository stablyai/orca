import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { getStructuredAgentSessionHost } from '../../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { prepareAutomationFullAccess } from '../../../../../../../automations/launch/automation-chat-permission'
import {
  resolveStructuredWorkerIdentity,
  structuredWorkerSession
} from '../../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export async function prepareFullAccessWorkerReuse(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<void> {
  const identity = resolveStructuredWorkerIdentity(handle, runtime.getOrchestrationDb())
  const host = getStructuredAgentSessionHost()
  if (!identity || !host) {
    throw new Error(
      'Full Access cannot be applied to this existing terminal; start a fresh worker without --terminal.'
    )
  }
  const running = structuredWorkerSession(identity)
  await prepareAutomationFullAccess(
    host,
    running.kind === 'here' ? running.sessionId : identity.sessionId
  )
}
