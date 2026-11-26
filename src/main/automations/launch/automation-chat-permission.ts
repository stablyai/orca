import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { mintAgentSessionOperationId } from '../../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { botRequiresFullAccess } from '../../bots/bot-full-access-policy'

export async function prepareAutomationAccess(
  runtime: OrcaRuntimeService,
  sessionId: string,
  scope: { botId?: string; automation: boolean } = { automation: true }
): Promise<void> {
  if (
    !(scope.automation && runtime.requireStore().getSettings().automationFullAccess === true) &&
    !(scope.botId && botRequiresFullAccess(runtime, scope.botId))
  ) {
    return
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_sessions_unavailable')
  }
  await prepareAutomationFullAccess(host, sessionId)
}

export async function prepareAutomationFullAccess(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<void> {
  const record = host.deps.store.requireWritableRecord(sessionId)
  if (record.permissionMode === 'full-access') {
    return
  }
  const fields = { key: AGENT_CHAT_PERMISSION_MODE_OPTION_ID, value: 'full-access' }
  const result = await host.setOption(
    { callerKey: 'automation-permission' },
    {
      ...fields,
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: record.lease.runtimeFence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId,
          fields
        })
      }
    }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
}
