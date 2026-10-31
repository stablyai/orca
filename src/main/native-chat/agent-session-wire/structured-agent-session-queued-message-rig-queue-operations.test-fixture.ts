import type {
  AgentSessionQueuePause,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
export function queuedMessageRigQueueOperations(
  host: () => StructuredAgentSessionHost,
  envelope: (
    fields: Record<string, unknown>,
    method: string,
    clientOperationId: string,
    sessionId?: string
  ) => AgentSessionMutationEnvelope,
  caller: { callerKey: string },
  SESSION: string
) {
  function sendNow(
    messageId: string,
    clientOperationId = hostTestOperationId(),
    sessionId = SESSION
  ) {
    return host().queuedMessageSend(caller, {
      envelope: envelope(
        { messageId },
        'agentSession.queuedMessageSend',
        clientOperationId,
        sessionId
      ),
      messageId
    })
  }
  function deleteQueued(messageId: string, clientOperationId = hostTestOperationId()) {
    return host().queuedMessageDelete(caller, {
      envelope: envelope({ messageId }, 'agentSession.queuedMessageDelete', clientOperationId),
      messageId
    })
  }
  function resume(clientOperationId = hostTestOperationId()) {
    return host().queuedMessagesResume(caller, {
      envelope: envelope({}, 'agentSession.queuedMessagesResume', clientOperationId)
    })
  }

  async function drafts(
    sessionId = SESSION
  ): Promise<{ messageId: string; state: string; paused?: true }[]> {
    const page = await host().history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return (page.page.queuedMessages ?? []).map(({ messageId, state, paused }) => ({
      messageId,
      state,
      ...(paused ? { paused } : {})
    }))
  }

  async function queuePause(sessionId = SESSION): Promise<AgentSessionQueuePause | null> {
    const page = await host().history({ sessionId, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return page.page.queuePause ?? null
  }
  return { sendNow, deleteQueued, resume, drafts, queuePause }
}
