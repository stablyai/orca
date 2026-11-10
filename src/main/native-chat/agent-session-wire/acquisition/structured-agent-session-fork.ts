import {
  admitStructuredAgentSessionFork,
  type StructuredAgentSessionForkInput
} from './structured-agent-session-fork-source'
import { prepareForkSnapshot } from './structured-agent-session-fork-snapshot'
import { agentSessionJournalProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/agent-session-chat-label'
import {
  normalizeAgentSessionConversationName,
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH
} from '../../../../shared/agent-session/agent-session-conversation-name'
import { sliceAtCodeUnitLimit } from '../../../../shared/surrogate-safe-text-slice'
import { AgentConversationCopyError } from '../../agent-conversation-copy-error'
import { acpAgentName } from '../../../acp/session/acp-structured-agent-definitions'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { requireUnownedStructuredAgentSessionAdoption } from '../../../runtime/agent-session/structured-agent-session-create-adoption'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export async function prepareStructuredAgentSessionFork(
  input: StructuredAgentSessionForkInput
): Promise<AgentSessionAttachParams> {
  const { host } = input
  const name = acpAgentName(input.agent)
  const {
    record,
    metadata,
    transcriptImport,
    selected,
    sourceHead,
    providerSessionId,
    requireCurrent,
    fail,
    throughItemId,
    destinationCwd
  } = await admitStructuredAgentSessionFork(input)
  const title = normalizeAgentSessionConversationName(
    `${sliceAtCodeUnitLimit(record.conversationName?.trim() || defaultAgentChatLabel(input.agent), AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 5)} fork`
  )!
  const copy = await host.deps.adapter.copyConversation!({
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
    accountHome: record.accountHome,
    ...(destinationCwd ? { destinationCwd } : {})
  }).catch((error: unknown) => {
    if (isAgentSessionRefusalError(error)) {
      return fail(error)
    }
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
  const current = await requireCurrent()
  if (!copy.sessionId.trim() || copy.sessionId === providerSessionId) {
    fail(`${name} did not save an independent chat copy. Try again.`)
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
    nativeId: transcriptImport.handleNamesTranscript ? copy.filePath! : copy.sessionId,
    ...(copy.resumeCursor ? { resumeCursor: copy.resumeCursor } : {})
  }
  const prepared = prepareForkSnapshot({
    snapshot: current.snapshot,
    nextItemId: current.boundary.nextItemId,
    ...(input.agent === 'codex'
      ? { sourceThreadId: providerSessionId, childThreadId: copy.sessionId }
      : {})
  })
  return {
    envelope: input.envelope,
    fork: {
      sessionId: record.sessionId,
      itemId: throughItemId,
      revalidate: async () => {
        await requireCurrent()
      },
      prepared,
      ...(copy.coverage
        ? {
            historyOrigin: {
              version: 1 as const,
              kind: 'native_copy' as const,
              providerHandle: agentSessionJournalProviderHandle({
                agent: input.agent,
                providerHandle
              }),
              agent: input.agent,
              ...copy.coverage,
              ids: [...new Set(copy.coverage.ids)]
            }
          }
        : {})
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
    adopt: { providerHandle, conversationName: title }
  }
}
