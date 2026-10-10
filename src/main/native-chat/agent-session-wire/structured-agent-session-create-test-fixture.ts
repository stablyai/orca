import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import {
  hostTestAttachParams,
  hostTestOperationId,
  HOST_TEST_SESSION
} from './structured-agent-session-host-test-data'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export const CREATE_TEST_CALLER = { callerKey: 'client-1' }

export function createTestParams(
  firstMessage?: StructuredAgentSessionFirstMessage,
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams {
  const params = hostTestAttachParams(null, { providerHandle: undefined, ...overrides })
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: params.envelope.sessionId,
        fields: {
          worktree: `id:${params.location.workspaceId}`,
          agent: params.agent,
          firstMessage,
          options: params.options,
          tabId: params.surfaceTabId
        }
      })
    }
  }
}

export function stopCreatedChat(
  host: StructuredAgentSessionHost,
  sessionId = HOST_TEST_SESSION,
  expectedRuntimeFence: number | null = null
) {
  const envelope: AgentSessionMutationEnvelope = {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.cancel',
      sessionId,
      fields: {}
    })
  }
  return host.cancel(CREATE_TEST_CALLER, { envelope })
}
