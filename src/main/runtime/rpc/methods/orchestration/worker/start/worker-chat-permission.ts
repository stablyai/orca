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

export type CoordinatorChatPermission = {
  agent: string
  mode: AgentChatPermissionChoice
}

export function snapshotCoordinatorChatPermission(
  caller: OrchestrationEntryCaller | undefined
): CoordinatorChatPermission | undefined {
  const session = sessionCallerOf(caller)
  const host = session && getStructuredAgentSessionHost()
  if (!session || !host) {
    return undefined
  }
  const { sessionId } = session
  const record = host.deps.store.getRecord(sessionId)
  if (!record) {
    return undefined
  }
  const support = agentChatPermissionModes(record.provider)
  if (!support) {
    return undefined
  }
  const saved = savedChatPermissionMode(support, record.permissionMode)
  const { adapter } = host.deps
  const launch = host.reads.childLaunchPermissionMode(sessionId)
  const requiresAcquisition = adapter.permissionModeRequiresAcquisition?.(sessionId, saved)
  if (saved === 'own') {
    const pending = requiresAcquisition ?? (launch !== undefined && launch !== 'own')
    return { agent: record.provider, mode: pending ? 'ask' : saved }
  }
  const running = adapter.runningPermissionMode?.(sessionId) ?? launch
  const pending = requiresAcquisition === true || (running !== undefined && running !== saved)
  return { agent: record.provider, mode: pending ? 'ask' : saved }
}
