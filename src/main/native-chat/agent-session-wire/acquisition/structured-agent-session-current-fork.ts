import { copyStructuredAgentSessionCurrentContext } from './structured-agent-session-current-copy'
import { agentSessionJournalProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { activeProviderContext } from '../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import { agentSessionExecutionLocationsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionPinnedLaunchDirectory } from '../../../runtime/agent-session/records/agent-session-record-launch-directory'
import { structuredAgentRuntimeMetadata } from '../../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { requireUnownedStructuredAgentSessionAdoption } from '../../../runtime/agent-session/ownership/structured-agent-session-create-adoption'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export async function prepareStructuredAgentSessionCurrentFork(input: {
  host: StructuredAgentSessionHost
  callerKey?: string
  forkFrom: { sessionId: string; current: true; permission: 'inherit' }
  agent: AgentSessionAttachParams['agent']
  location: AgentSessionAttachParams['location']
  envelope: { sessionId: string; clientOperationId: string }
}): Promise<AgentSessionAttachParams & { hostLaunchDirectory?: string }> {
  const { host, forkFrom } = input
  const fail = (): never => {
    throw agentSessionRefusalError(
      'agent_session_operation_invalid',
      { reason: 'savedConversationMissing' },
      'The source chat has no confirmed context to copy. Open it again, then try again.'
    )
  }
  const metadata = structuredAgentRuntimeMetadata(input.agent)
  if (
    !metadata?.transcriptImport ||
    !host.deps.agents.capabilities(input.agent)?.currentFork ||
    !host.deps.adapter.copyConversation
  ) {
    throw agentSessionRefusalError(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      'This host cannot open a side chat from the current context.'
    )
  }
  if (!input.callerKey) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const source = host.deps.store.getRecord(forkFrom.sessionId) ?? fail()
  const context = activeProviderContext(source)
  const current = () => {
    const record = host.deps.store.getRecord(source.sessionId) ?? fail()
    const next = activeProviderContext(record)
    if (
      record.provider !== input.agent ||
      !agentSessionExecutionLocationsEqual(record.location, input.location) ||
      source.sessionId === input.envelope.sessionId ||
      !next.head ||
      next.pendingClear ||
      record.rewind?.phase === 'prepared' ||
      record.rewind?.phase === 'provider-succeeded' ||
      (record.conversationCommand?.command === 'clear' &&
        (record.conversationCommand.phase === 'prepared' ||
          record.conversationCommand.state === 'unknown')) ||
      next.head.linkId !== context.head?.linkId ||
      JSON.stringify(record.providerContextBoundary) !==
        JSON.stringify(source.providerContextBoundary) ||
      JSON.stringify(record.rewind) !== JSON.stringify(source.rewind)
    ) {
      fail()
    }
    return next.head!
  }
  const handle = current().handle
  const codexSource =
    input.agent === 'codex'
      ? {
          workspaceCwd:
            agentSessionPinnedLaunchDirectory(source) ??
            (await host.deps.resolveWorkspacePath?.(source.location.workspaceId)) ??
            fail(),
          conversationStore:
            metadata.transcriptImport.conversationStore({
              accountHome: source.accountHome,
              launchEnv: {
                ...process.env,
                ...(await host.deps.resolveLaunchEnv?.(input.agent))
              }
            }) ?? fail()
        }
      : null
  const copy = await copyStructuredAgentSessionCurrentContext({
    store: host.deps.store,
    callerKey: input.callerKey,
    envelope: input.envelope,
    permission: forkFrom.permission,
    copy: (copyInput) => host.deps.adapter.copyConversation!(copyInput),
    source: {
      current: true,
      record: source,
      identity: {
        sessionId: source.sessionId,
        agent: input.agent,
        workspaceId: source.location.workspaceId,
        hostId: source.location.executionHostId,
        providerHandle: handle
      },
      providerSessionId: handle.nativeId,
      accountHome: source.accountHome
    }
  })
  current()
  if (
    !copy.filePath ||
    !copy.coverage ||
    !copy.sessionId.trim() ||
    copy.sessionId === handle.nativeId
  ) {
    return fail()
  }
  requireUnownedStructuredAgentSessionAdoption({
    host,
    agent: input.agent,
    providerSessionId: copy.sessionId,
    selfSessionId: input.envelope.sessionId
  })
  const providerHandle = {
    transport: metadata.definition.handleTransport,
    agent: input.agent,
    nativeId: metadata.transcriptImport.handleNamesTranscript ? copy.filePath : copy.sessionId,
    ...(copy.resumeCursor ? { resumeCursor: copy.resumeCursor } : {})
  }
  return {
    envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    runtimeKind: 'native',
    accountHome: source.accountHome,
    hostLaunchDirectory: agentSessionPinnedLaunchDirectory(source),
    sideChat: { sourceSessionId: source.sessionId, sourceProviderSessionId: handle.nativeId },
    options: {
      ...source.options,
      ...(source.permissionMode
        ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: source.permissionMode }
        : {})
    },
    ...(source.launchArgs ? { launchArgs: source.launchArgs } : {}),
    adopt: {
      providerHandle,
      transcriptPath: copy.filePath,
      historyOrigin: {
        version: 1,
        kind: 'native_copy',
        providerHandle: agentSessionJournalProviderHandle({ agent: input.agent, providerHandle }),
        agent: input.agent,
        ...copy.coverage
      },
      ...(codexSource ? { source: { ...codexSource, providerSessionId: copy.sessionId } } : {})
    }
  }
}
