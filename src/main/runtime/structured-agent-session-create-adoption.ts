import { stat } from 'node:fs/promises'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../shared/agent-session-wire-refusals'
import { prepareCodexAdoption } from '../native-chat/codex-adoption-preparation'
import type { NativeCodexResumePreparation } from '../codex/codex-ai-vault-session-resume'
import type { StructuredAgentSessionResumeSource } from '../../shared/structured-agent-session-create'
import type { StructuredAgentCliSourceEvidence } from '../native-chat/structured-agent-cli-source'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type {
  AgentSessionProviderHandle,
  StructuredAgentId
} from '../../shared/agent-session-provider-handle'
import { agentSessionExecutionLocationsEqual } from '../../shared/agent-session-record'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  findCommittedStructuredAgentSessionAdoptionReplay,
  findConflictingStructuredAdoption,
  resolveStructuredAgentSessionAdoption,
  structuredAdoptionConflictError
} from '../native-chat/structured-agent-session-history-adoption'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import type {
  StructuredAgentTranscriptImport,
  StructuredAgentTranscriptImportSettings
} from '../native-chat/structured-agent-cli-conversations'

export type StructuredAgentSessionCreateIntentInput = {
  envelope: { sessionId: string; clientOperationId: string }
  worktree: string
  agent: StructuredAgentId
  callerKey?: string
  resumeFrom?: StructuredAgentSessionResumeSource
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
}

export function resolveCommittedStructuredAgentSessionAdoptionIntent(input: {
  host: StructuredAgentSessionHost | null
  envelope: { sessionId: string; clientOperationId: string }
  agent: StructuredAgentId
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
  location: AgentSessionExecutionLocation
  options?: Readonly<Record<string, string>>
}): AgentSessionAttachParams | null {
  const history = structuredAgentRuntimeMetadata(input.agent)?.sessionHistory
  const replay =
    input.resumeFrom && input.callerKey && input.host && history
      ? findCommittedStructuredAgentSessionAdoptionReplay({
          agent: input.agent,
          providerSessionId: input.resumeFrom.providerSessionId,
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
    ...(input.options ? { options: input.options } : {}),
    adopt: { providerHandle: replay.providerHandle },
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
        ownership: listStructuredProviderSessionOwnership(input.host.deps.store.listRecords())
      })
    : null
  if (conflict) {
    throw structuredAdoptionConflictError(conflict)
  }
}

export async function resolveStructuredAgentSessionAdoptionForCreate(input: {
  settings: StructuredAgentTranscriptImportSettings
  agent: StructuredAgentId
  /** The agent's registered importer; only an agent with one adopts. */
  transcriptImport: StructuredAgentTranscriptImport
  providerSessionId: string
  selectedAccountHome: AgentSessionAccountHome
  launchEnv: NodeJS.ProcessEnv
  workspaceCwd: string
  resolveTranscriptPath?: () => string | undefined
  prepareCodexResume?: NativeCodexResumePreparation
}) {
  try {
    const transcriptPath = input.resolveTranscriptPath?.()
    const candidates = input.transcriptImport.accountHomeCandidates(input)
    // Each account's store is resolved once, so the hook path, the lookup and its re-admission
    // all judge the same place even if the environment changes mid-create.
    const stores = new Map<AgentSessionAccountHome, string | null>()
    const storeOf = (accountHome: AgentSessionAccountHome): string | null => {
      if (!stores.has(accountHome)) {
        stores.set(
          accountHome,
          input.transcriptImport.conversationStore({
            accountHome,
            launchEnv: input.launchEnv
          })
        )
      }
      return stores.get(accountHome) ?? null
    }
    let admitted: { accountHome: AgentSessionAccountHome; path: string } | null = null
    if (transcriptPath) {
      for (const accountHome of candidates) {
        const store = storeOf(accountHome)
        const path = store
          ? await input.transcriptImport.admitTranscriptPath({ store, transcriptPath })
          : null
        if (path) {
          admitted = { accountHome, path }
          break
        }
      }
    }
    if (transcriptPath && !admitted) {
      throw new Error('The conversation account is not available on this host.')
    }
    const adoption = await resolveStructuredAgentSessionAdoption({
      providerSessionId: input.providerSessionId,
      candidateAccountHomes: admitted ? [admitted.accountHome] : candidates,
      resolveTranscript: async (args) => {
        const exact = admitted?.path
        if (exact) {
          try {
            if ((await stat(exact)).isFile()) {
              return exact
            }
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                'code' in error &&
                (error.code === 'ENOENT' || error.code === 'ENOTDIR')
              )
            ) {
              throw error
            }
          }
        }
        const store = storeOf(args.accountHome)
        if (!store) {
          return null
        }
        const found = await input.transcriptImport.findTranscript({
          providerSessionId: args.providerSessionId,
          store,
          launchEnv: args.launchEnv,
          workspaceCwd: args.workspaceCwd,
          strictErrors: true
        })
        if (!found) {
          return null
        }
        const path = await input.transcriptImport.admitTranscriptPath({
          store,
          transcriptPath: found
        })
        if (!path) {
          throw new Error('The conversation path is outside its account storage.')
        }
        return path
      },
      launchEnv: input.launchEnv,
      workspaceCwd: input.workspaceCwd
    })
    return input.agent === 'codex'
      ? await prepareCodexAdoption(
          adoption,
          input.providerSessionId,
          input.prepareCodexResume,
          candidates
        )
      : adoption
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

/** `adopt` is what makes the reservation seed the handle chain. Presence of `providerHandle` alone
 *  must not: `agentSession.ensure` already passes one today without adopting anything. */
export function structuredAgentSessionAdoptAttach(input: {
  definition: {
    handleTransport: AgentSessionProviderHandle['transport']
    agent: AgentSessionProviderHandle['agent']
  }
  handleNamesTranscript: boolean | undefined
  transcriptPath: string
  providerSessionId: string
  workspaceCwd: string
}): NonNullable<AgentSessionAttachParams['adopt']> {
  return {
    providerHandle: {
      transport: input.definition.handleTransport,
      agent: input.definition.agent,
      nativeId: input.handleNamesTranscript ? input.transcriptPath : input.providerSessionId
    },
    transcriptPath: input.transcriptPath,
    source: { providerSessionId: input.providerSessionId, workspaceCwd: input.workspaceCwd }
  }
}
