import type { AgentChatPermissionChoice } from '../../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentChatPermissionModes,
  savedChatPermissionMode
} from '../../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { getStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../../../../orchestration/addressing/orchestration-caller-identity'

export function snapshotCoordinatorChatPermission(
  caller: OrchestrationEntryCaller | undefined
): AgentChatPermissionChoice | undefined {
  const session = sessionCallerOf(caller)
  const host = session && getStructuredAgentSessionHost()
  if (!session || !host) {
    return undefined
  }
  const record = host.deps.store.getRecord(session.sessionId)
  if (record?.permissionMode === undefined) {
    return undefined
  }
  const support = agentChatPermissionModes(record.provider)
  if (!support) {
    return undefined
  }
  const saved = savedChatPermissionMode(support, record.permissionMode)
  const running = host.deps.adapter.runningPermissionMode?.(session.sessionId)
  return running === undefined || running === saved ? saved : 'ask'
}
