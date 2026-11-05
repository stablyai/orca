import { importedAgentSessionForkTipSettled } from './imported-agent-session-fork-tip'
import { defaultAgentChatLabel } from '../../shared/agent-session/agent-session-chat-label'
import {
  normalizeAgentSessionConversationName,
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
} from '../../shared/agent-session/agent-session-conversation-name'
import { sliceAtCodeUnitLimit } from '../../shared/surrogate-safe-text-slice'
import { AgentConversationCopyError } from './agent-conversation-copy-error'
import { structuredAgentSessionForkBoundary } from './agent-session-wire/structured-agent-session-fork-boundary'
import { acpAgentName } from '../acp/acp-structured-agent-definitions'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { activeProviderContext } from '../../shared/agent-session/agent-session-provider-context'
import { agentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  resolveCommittedStructuredAgentSessionAdoptionIntent,
  resolveStructuredAgentSessionAdoptionForCreate,
  requireUnownedStructuredAgentSessionAdoption,
  structuredAgentSessionAdoptAttach
} from '../runtime/agent-session/structured-agent-session-create-adoption'
import { structuredAgentRuntimeMetadata } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import type { AgentSessionAttachParams } from './agent-session-wire/structured-agent-session-attach'

export async function prepareStructuredAgentSessionFork(input: {
  host: StructuredAgentSessionHost
  sessionId: string
  throughItemId: string
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  envelope: AgentSessionAttachParams['envelope']
}): Promise<AgentSessionAttachParams> {
  const { host } = input
  const name = acpAgentName(input.agent)
  if (host.deps.store.selectWritableRecord(input.sessionId).kind === 'missing') {
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'recordMissing' },
      `${name} could not find the source chat. Open the chat again, then try again.`
    )
  }
  const record = host.deps.store.requireWritableRecord(input.sessionId)
  const metadata = structuredAgentRuntimeMetadata(input.agent)
  const capability = host.deps.agents.capabilities(input.agent)?.fork
  const { head, pendingClear } = activeProviderContext(record)
  const fail = (
    message: string,
    reason:
      | 'conversationCleared'
      | 'rewindUnconfirmed'
      | 'turnActive'
      | 'savedConversationMissing'
      | 'providerRejected'
      | 'launchFolderMissing' = 'savedConversationMissing'
  ): never => {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason }, message)
  }
  if (!capability || !metadata?.transcriptImport || !host.deps.adapter.copyConversation) {
    throw agentSessionRefusalError(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      `${name} cannot copy a chat. Update ${name}, then try again.`
    )
  }
  if (
    record.provider !== input.agent ||
    !agentSessionExecutionLocationsEqual(record.location, input.location) ||
    input.sessionId === input.envelope.sessionId
  ) {
    fail(`${name} could not open the source chat in this workspace. Open it again and try again.`)
  }
  if (
    !head ||
    pendingClear ||
    (record.conversationCommand?.command === 'clear' &&
      (record.conversationCommand.phase === 'prepared' ||
        record.conversationCommand.state === 'unknown')) ||
    record.rewind?.phase === 'prepared' ||
    record.rewind?.phase === 'provider-succeeded'
  ) {
    fail(
      `${name} has no confirmed saved context to copy. Finish the rewind or send a message, then try again.`,
      pendingClear || !head ? 'conversationCleared' : 'rewindUnconfirmed'
    )
  }
  const sourceHead = head ?? fail(`${name} has no saved context. Send a message, then try again.`)
  const snapshot = await host.journalSnapshot(record.sessionId)
  const boundary = structuredAgentSessionForkBoundary(
    snapshot,
    record,
    input.throughItemId,
    capability
  )
  const selected =
    boundary ??
    fail(
      `${name} could not find this response in the current chat. Open the chat again and try again.`
    )
  const admissions = host.deps.store.admittedSendCount(record.sessionId)
  const dispatch = JSON.stringify(snapshot.submissions)
  const cwd =
    record.launchDirectory ?? (await host.deps.resolveWorkspacePath?.(record.location.workspaceId))
  if (!cwd) {
    fail(
      `${name} could not open the source workspace. Open it again and try again.`,
      'launchFolderMissing'
    )
  }
  const workspaceCwd =
    cwd ??
    fail(
      `${name} could not open the source workspace. Open it again and try again.`,
      'launchFolderMissing'
    )
  const launchEnv = { ...process.env, ...(await host.deps.resolveLaunchEnv?.(input.agent)) }
  const providerSessionId = metadata.sessionHistory.rowSessionId(sourceHead)
  if (capability === 'tip' && selected.latest && !selected.checkpoint.settled) {
    selected.checkpoint.settled = await importedAgentSessionForkTipSettled({
      record,
      providerSessionId,
      selectedItemId: selected.checkpoint.selectedItemId,
      workspaceCwd,
      launchEnv
    })
  }
  if (capability === 'tip' && (!selected.latest || !selected.checkpoint.settled)) {
    fail(
      `${name} can only fork its latest finished response. Wait for it to finish, then try again.`,
      'turnActive'
    )
  }
  const requireCurrent = async () => {
    const current = host.deps.store.requireWritableRecord(record.sessionId)
    const currentSnapshot = await host.journalSnapshot(record.sessionId)
    const context = activeProviderContext(current)
    const transitionPending =
      context.pendingClear ||
      current.rewind?.phase === 'prepared' ||
      current.rewind?.phase === 'provider-succeeded' ||
      (current.conversationCommand?.command === 'clear' &&
        (current.conversationCommand.phase === 'prepared' ||
          current.conversationCommand.state === 'unknown'))
    const currentBoundary = transitionPending
      ? null
      : structuredAgentSessionForkBoundary(
          currentSnapshot,
          current,
          input.throughItemId,
          capability
        )
    if (
      !agentSessionExecutionLocationsEqual(current.location, record.location) ||
      currentBoundary?.retained !== selected.retained ||
      (capability === 'tip' &&
        (host.deps.store.admittedSendCount(record.sessionId) !== admissions ||
          JSON.stringify(currentSnapshot.submissions) !== dispatch ||
          !currentBoundary.latest))
    ) {
      fail(`${name} could not finish the copy because the source context changed. Try again.`)
    }
  }
  await requireCurrent()
  const title = normalizeAgentSessionConversationName(
    `${sliceAtCodeUnitLimit(record.conversationName?.trim() || defaultAgentChatLabel(input.agent), AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 5)} fork`
  )!
  const copy = await host.deps.adapter
    .copyConversation({
      record,
      checkpoint: selected.checkpoint,
      title,
      identity: {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: record.location.executionHostId,
        agent: input.agent,
        providerHandle: sourceHead.handle
      },
      providerSessionId,
      accountHome: record.accountHome
    })
    .catch((error: unknown) => {
      host.deps.logger.warn('native conversation copy failed', {
        scope: 'chat-fork',
        sessionId: record.sessionId,
        error
      })
      return fail(
        error instanceof AgentConversationCopyError
          ? error.message
          : error instanceof Error &&
              (error.name === 'TimeoutError' ||
                (error.cause instanceof Error && error.cause.name === 'TimeoutError'))
            ? `${name} took too long to copy this chat. Try again.`
            : `${name} could not copy this conversation. Try again.`,
        'providerRejected'
      )
    })
  await requireCurrent()
  if (!copy.sessionId.trim() || copy.sessionId === providerSessionId) {
    fail(`${name} did not save an independent chat copy. Try again.`)
  }
  requireUnownedStructuredAgentSessionAdoption({
    host,
    agent: input.agent,
    providerSessionId: copy.sessionId,
    selfSessionId: input.envelope.sessionId
  })
  const importer = metadata.transcriptImport
  const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
    settings: {},
    agent: input.agent,
    transcriptImport: { ...importer, accountHomeCandidates: () => [record.accountHome] },
    providerSessionId: copy.sessionId,
    selectedAccountHome: record.accountHome,
    launchEnv,
    workspaceCwd
  })
  await requireCurrent()
  return {
    envelope: input.envelope,
    fork: {
      sessionId: record.sessionId,
      itemId: input.throughItemId,
      title,
      revalidate: requireCurrent
    },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    accountHome: record.accountHome,
    runtimeKind: 'native',
    options: {
      ...record.options,
      ...(record.permissionMode
        ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: record.permissionMode }
        : {})
    },
    ...(record.launchArgs ? { launchArgs: record.launchArgs } : {}),
    adopt: structuredAgentSessionAdoptAttach({
      definition: metadata.definition,
      handleNamesTranscript: importer.handleNamesTranscript,
      transcriptPath: adoption.transcriptPath,
      providerSessionId: copy.sessionId,
      workspaceCwd,
      ...(input.agent === 'codex'
        ? {
            conversationStore:
              importer.conversationStore({ accountHome: record.accountHome, launchEnv }) ??
              undefined
          }
        : {})
    })
  }
}

export async function resolveStructuredAgentSessionForkIntent(input: {
  host: StructuredAgentSessionHost | null
  forkFrom: { sessionId: string; throughItemId: string }
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  envelope: { sessionId: string; clientOperationId: string }
  callerKey?: string
}): Promise<AgentSessionAttachParams> {
  const { host } = input
  if (!host) {
    throw agentSessionRefusalError(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      `${acpAgentName(input.agent)} could not reach the execution host. Reconnect to the host, then try again.`
    )
  }
  return (
    resolveCommittedStructuredAgentSessionAdoptionIntent({ ...input, host }) ??
    prepareStructuredAgentSessionFork({
      ...input,
      host,
      sessionId: input.forkFrom.sessionId,
      throughItemId: input.forkFrom.throughItemId,
      envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' }
    })
  )
}
