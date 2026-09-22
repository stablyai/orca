import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
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
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { configuredAdditionalCodexHomePaths } from '../ai-vault/cached-session-list'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'

type AdoptionSettings = {
  codexManagedAccounts?: readonly { managedHomePath: string }[]
}

export function resolveCommittedStructuredAgentSessionAdoptionIntent(input: {
  host: StructuredAgentSessionHost | null
  envelope: { sessionId: string; clientOperationId: string }
  agent: 'claude' | 'codex'
  callerKey?: string
  resumeFrom?: { providerSessionId: string }
  location: AgentSessionExecutionLocation
  options?: Readonly<Record<string, string>>
}): AgentSessionAttachParams | null {
  const replay =
    input.resumeFrom && input.callerKey && input.host
      ? findCommittedStructuredAgentSessionAdoptionReplay({
          agent: input.agent,
          providerSessionId: input.resumeFrom.providerSessionId,
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
    runtimeKind: replay.record.lease.runtimeKind
  }
}

export async function resolveStructuredAgentSessionAdoptionForCreate(input: {
  host: StructuredAgentSessionHost | null
  settings: AdoptionSettings
  agent: 'claude' | 'codex'
  providerSessionId: string
  selfSessionId: string
  selectedAccountHomePath: string
}) {
  const conflict = input.host
    ? findConflictingStructuredAdoption({
        agent: input.agent,
        providerSessionId: input.providerSessionId,
        selfSessionId: input.selfSessionId,
        ownership: listStructuredProviderSessionOwnership(input.host.deps.store.listRecords())
      })
    : null
  if (conflict) {
    throw structuredAdoptionConflictError(conflict)
  }
  return resolveStructuredAgentSessionAdoption({
    agent: input.agent,
    providerSessionId: input.providerSessionId,
    candidateAccountHomes: structuredAdoptionAccountHomeCandidates(input),
    resolveTranscript: async ({ agent, providerSessionId, accountHomePath }) =>
      resolveSessionFilePath(
        agent,
        providerSessionId,
        agent === 'claude'
          ? { claudeProjectsDir: join(accountHomePath, 'projects') }
          : { codexSessionsDirs: [join(accountHomePath, 'sessions')] }
      )
  })
}

/** Recognised adoption homes, most-preferred first. */
function structuredAdoptionAccountHomeCandidates(input: {
  settings: AdoptionSettings
  agent: 'claude' | 'codex'
  selectedAccountHomePath: string
}): string[] {
  if (input.agent === 'claude') {
    return [input.selectedAccountHomePath, join(homedir(), '.claude')]
  }
  return [
    input.selectedAccountHomePath,
    ...(input.settings.codexManagedAccounts ?? []).map((account) => account.managedHomePath),
    ...configuredAdditionalCodexHomePaths(),
    getOrcaManagedCodexHomePath(),
    getSystemCodexHomePath()
  ]
}
