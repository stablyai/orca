import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { prepareCodexAdoption } from '../../../native-chat/conversation-adoption/codex-adoption-preparation'
import { isAiVaultTitleAgent } from '../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { generatedSessionTitle } from '../../../ai-vault/parsing/session-scanner-accumulator'
import { resolveLocalAiVaultSessionTitles } from '../../../ai-vault/session-titles/session-title-resolver'
import type { StructuredAgentSessionResumeSource } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentCliSourceEvidence } from '../../../native-chat/conversation-adoption/structured-agent-cli-source'
import type {
  AgentSessionProviderHandle,
  StructuredAgentId
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import {
  type AgentSessionExecutionLocation,
  agentSessionExecutionLocationsEqual
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import {
  findCommittedStructuredAgentSessionAdoptionReplay,
  findConflictingStructuredAdoption,
  structuredAdoptionConflictError
} from '../../../native-chat/conversation-adoption/structured-agent-session-history-adoption'
import { structuredAgentRuntimeMetadata } from '../installation/structured-agent-runtime-metadata'
import {
  findStructuredAgentSessionAdoptionTranscript,
  type StructuredAgentSessionAdoptionInput
} from './structured-agent-session-adoption-transcript'

export type StructuredAgentSessionCreateIntentInput = {
  envelope: { sessionId: string; clientOperationId: string }
  worktree: string
  agent: StructuredAgentId
  callerKey?: string
  forkFrom?: { sessionId: string; throughItemId: string }
  resumeFrom?: StructuredAgentSessionResumeSource
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
}

export function resolveCommittedStructuredAgentSessionAdoptionIntent(input: {
  host: StructuredAgentSessionHost | null
  envelope: { sessionId: string; clientOperationId: string }
  agent: StructuredAgentId
  callerKey?: string
  forkFrom?: { sessionId: string; throughItemId: string }
  resumeFrom?: { providerSessionId: string }
  location: AgentSessionExecutionLocation
  options?: Readonly<Record<string, string>>
}): AgentSessionAttachParams | null {
  const history = structuredAgentRuntimeMetadata(input.agent)?.sessionHistory
  const replay =
    (input.resumeFrom || input.forkFrom) && input.callerKey && input.host && history
      ? findCommittedStructuredAgentSessionAdoptionReplay({
          agent: input.agent,
          providerSessionId: input.resumeFrom?.providerSessionId,
          rowSessionId: history.rowSessionId,
          selfSessionId: input.envelope.sessionId,
          callerKey: input.callerKey,
          operationId: input.envelope.clientOperationId,
          record: input.host.deps.store.getRecord(input.envelope.sessionId),
          operations: input.host.deps.store.listOperationRows()
        })
      : null
  if (!replay || !agentSessionExecutionLocationsEqual(replay.record.location, input.location)) {
    return null
  }
  return {
    envelope: {
      sessionId: input.envelope.sessionId,
      clientOperationId: input.envelope.clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: input.location,
    provider: input.agent,
    agent: input.agent,
    accountHome: replay.record.accountHome,
    ...(input.forkFrom
      ? {
          options: {
            ...replay.record.options,
            ...(replay.record.permissionMode
              ? { permissionMode: replay.record.permissionMode }
              : {})
          },
          ...(replay.record.launchArgs ? { launchArgs: replay.record.launchArgs } : {})
        }
      : input.options
        ? { options: input.options }
        : {}),
    ...(replay.providerHandle ? { adopt: { providerHandle: replay.providerHandle } } : {}),
    runtimeKind: 'native'
  }
}

export function requireUnownedStructuredAgentSessionAdoption(input: {
  host: StructuredAgentSessionHost | null
  agent: StructuredAgentId
  providerSessionId: string
  selfSessionId: string
}): void {
  const conflict = input.host
    ? findConflictingStructuredAdoption({
        ...input,
        ownership: listStructuredProviderSessionOwnership(input.host.deps.store.listConversations())
      })
    : null
  if (conflict) {
    throw structuredAdoptionConflictError(conflict)
  }
}

export async function resolveStructuredAgentSessionAdoptionForCreate(
  input: StructuredAgentSessionAdoptionInput
) {
  try {
    const { adoption, candidates } = await findStructuredAgentSessionAdoptionTranscript(input)
    // Title from where History found the transcript: Codex preparation may copy it to another home.
    const [prepared, conversationName] = await Promise.all([
      input.agent === 'codex'
        ? prepareCodexAdoption(
            adoption,
            input.providerSessionId,
            input.prepareCodexResume,
            candidates
          )
        : adoption,
      input.conversationName ??
        resolveAdoptedConversationName({
          agent: input.agent,
          providerSessionId: input.providerSessionId,
          transcriptPath: adoption.transcriptPath
        })
    ])
    return { ...prepared, conversationName }
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      throw error
    }
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'transcriptUnreadable' },
      error instanceof Error ? error.message : String(error)
    )
  }
}

const ADOPTED_CONVERSATION_NAME_TIMEOUT_MS = 2_000

/** The title Session History shows for the adopted conversation, so the chat opens under it. */
async function resolveAdoptedConversationName(input: {
  agent: StructuredAgentId
  providerSessionId: string
  transcriptPath: string
}): Promise<string | undefined> {
  if (!isAiVaultTitleAgent(input.agent)) {
    return undefined
  }
  // Naming is cosmetic: a failed lookup, or one queued behind a History scan, must not hold up the resume.
  const { titles } = await resolveLocalAiVaultSessionTitles(
    [
      {
        agent: input.agent,
        sessionId: input.providerSessionId,
        transcriptPath: input.transcriptPath
      }
    ],
    AbortSignal.timeout(ADOPTED_CONVERSATION_NAME_TIMEOUT_MS)
  ).catch(() => ({ titles: [] }))
  const title = titles[0]?.title
  // History's "<Agent> <id prefix>" fallback names nothing.
  return title && title !== generatedSessionTitle(input.agent, input.providerSessionId)
    ? title
    : undefined
}

/** Only adopt seeds the handle chain; ensure already passes providerHandle without adopting. */
export function structuredAgentSessionAdoptAttach(input: {
  definition: {
    handleTransport: AgentSessionProviderHandle['transport']
    agent: AgentSessionProviderHandle['agent']
  }
  handleNamesTranscript: boolean | undefined
  conversationStore?: string
  transcriptPath: string
  providerSessionId: string
  workspaceCwd: string
  conversationName?: string
}): NonNullable<AgentSessionAttachParams['adopt']> {
  return {
    providerHandle: {
      transport: input.definition.handleTransport,
      agent: input.definition.agent,
      nativeId: input.handleNamesTranscript ? input.transcriptPath : input.providerSessionId
    },
    transcriptPath: input.transcriptPath,
    source: {
      providerSessionId: input.providerSessionId,
      workspaceCwd: input.workspaceCwd,
      ...(input.conversationStore !== undefined
        ? { conversationStore: input.conversationStore }
        : {})
    },
    conversationName: input.conversationName
  }
}
