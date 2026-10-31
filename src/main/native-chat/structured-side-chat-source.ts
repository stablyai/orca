import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session-record-launch-directory'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'
import { activeProviderContext } from '../../shared/agent-session-provider-context'
import { isAgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'
import { agentSessionExecutionLocationsEqual } from '../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import type { AgentSessionAttachParams } from './agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionCreateIntentInput } from '../runtime/structured-agent-session-create-adoption'

export function structuredSideChatCreateIntent(
  input: StructuredAgentSessionCreateIntentInput & {
    host: StructuredAgentSessionHost | null
    location: AgentSessionExecutionLocation
  }
): AgentSessionAttachParams & { hostLaunchDirectory?: string } {
  if (!input.sideChatOf || input.resumeFrom) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  return {
    envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    runtimeKind: 'native',
    ...resolveStructuredSideChatSource({
      host: input.host,
      sourceSessionId: input.sideChatOf,
      sessionId: input.envelope.sessionId,
      agent: input.agent,
      location: input.location
    })
  }
}

export function resolveStructuredSideChatSource(input: {
  host: StructuredAgentSessionHost | null
  sourceSessionId: string
  sessionId: string
  agent: string
  location: AgentSessionExecutionLocation
}) {
  const prior = input.host?.deps.store.getRecord(input.sessionId)
  const source = input.host?.deps.store.getRecord(input.sourceSessionId)
  const record = prior ?? source
  const pinnedDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  const threadId = source && activeProviderContext(source).head?.handle.nativeId
  if (
    input.host?.deps.agents.definition(input.agent)?.capabilities.sideChat !== true ||
    !record ||
    record.provider !== input.agent ||
    (isFloatingWorkspaceId(record.location.workspaceId) && !pinnedDirectory) ||
    !agentSessionExecutionLocationsEqual(record.location, input.location) ||
    (prior
      ? prior.sideChat?.sourceSessionId !== input.sourceSessionId
      : !threadId || input.sessionId === input.sourceSessionId)
  ) {
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'transcriptUnreadable' },
      'This chat has no conversation available for a side chat.'
    )
  }
  return {
    accountHome: record.accountHome,
    ...(pinnedDirectory ? { hostLaunchDirectory: pinnedDirectory } : {}),
    options: isAgentChatPermissionChoice(record.permissionMode)
      ? { ...record.options, permissionMode: record.permissionMode }
      : record.options,
    sideChat: prior?.sideChat ?? {
      sourceSessionId: input.sourceSessionId,
      sourceProviderSessionId: threadId!
    }
  }
}
