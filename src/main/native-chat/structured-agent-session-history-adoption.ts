// Resolve credential homes and transcripts from host-owned facts, never client-supplied paths.

import { chatAgentsShareConversations } from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink,
  StructuredAgentId
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionOwnerObservation } from '../../shared/agent-session-conversation-view'
import { agentSessionOwnerObservationIsLive } from '../../shared/agent-session-lease-adjudication'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'

export type StructuredAgentSessionAdoptionOwnership = {
  sessionId: string
  workspaceId: string
  /** Any chat may own the conversation; only agents with importers can adopt it. */
  provider: StructuredAgentId
  providerSessionId: string
  ownerObservation: AgentSessionOwnerObservation
  role: 'head' | 'earlier'
}

export type StructuredAgentSessionAdoption = {
  /** The home where lookup actually found the transcript. */
  accountHome: AgentSessionAccountHome
  transcriptPath: string
}

export type CommittedStructuredAgentSessionAdoptionReplay = {
  record: AgentSessionRecord
  providerHandle: AgentSessionProviderHandle
}

/** Attach still validates the committed operation’s fingerprint. */
export function findCommittedStructuredAgentSessionAdoptionReplay(input: {
  agent: StructuredAgentId
  providerSessionId: string
  rowSessionId: (link: AgentSessionProviderHandleLink) => string
  selfSessionId: string
  callerKey: string
  operationId: string
  record: AgentSessionRecord | null
  operations: readonly AgentSessionOperationRow[]
}): CommittedStructuredAgentSessionAdoptionReplay | null {
  const operation = input.operations.find(
    (row) => row.callerKey === input.callerKey && row.operationId === input.operationId
  )
  if (
    operation?.outcome.status !== 'succeeded' ||
    operation.outcome.sessionId !== input.selfSessionId
  ) {
    return null
  }
  const record = input.record
  const adopted = record?.providerHandleChain[0]
  if (
    !record ||
    record.sessionId !== input.selfSessionId ||
    record.provider !== input.agent ||
    adopted?.origin !== 'adopted'
  ) {
    return null
  }
  if (input.rowSessionId(adopted) !== input.providerSessionId) {
    return null
  }
  return { record, providerHandle: adopted.handle }
}

/** Codex does not lock threads: concurrent writers silently diverge, so host ownership must reject them.
 * Exempt selfSessionId so committed-create retries can replay their own newly indexed record. */
export function findConflictingStructuredAdoption(input: {
  agent: StructuredAgentId
  providerSessionId: string
  selfSessionId: string
  ownership: readonly StructuredAgentSessionAdoptionOwnership[]
}): StructuredAgentSessionAdoptionOwnership | null {
  return (
    input.ownership.find(
      (owner) =>
        owner.sessionId !== input.selfSessionId &&
        owner.role === 'head' &&
        chatAgentsShareConversations(owner.provider, input.agent) &&
        owner.providerSessionId === input.providerSessionId
    ) ?? null
  )
}

/** Match PTY refusal vocabulary: admitted writers conflict; other owners remain unknown. Neither allows writing. */
export function structuredAdoptionConflictError(
  ownership: StructuredAgentSessionAdoptionOwnership
): Error {
  return agentSessionRefusalError(
    agentSessionOwnerObservationIsLive(ownership.ownerObservation)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown',
    {
      reason: 'conversationHeldElsewhere',
      owner: { sessionId: ownership.sessionId, workspaceId: ownership.workspaceId }
    }
  )
}

/** Try recognized homes in preference order; clients name only conversations.
 * Client-supplied homes/paths would select launch credentials and arbitrary journal import files. */
export async function resolveStructuredAgentSessionAdoption(input: {
  providerSessionId: string
  candidateAccountHomes: readonly AgentSessionAccountHome[]
  resolveTranscript: (args: {
    providerSessionId: string
    accountHome: AgentSessionAccountHome
    launchEnv: NodeJS.ProcessEnv
    workspaceCwd: string
  }) => Promise<string | null>
  launchEnv: NodeJS.ProcessEnv
  workspaceCwd: string
}): Promise<StructuredAgentSessionAdoption> {
  const seen: AgentSessionAccountHome[] = []
  for (const accountHome of input.candidateAccountHomes) {
    if (seen.some((home) => agentSessionAccountHomesEqual(home, accountHome))) {
      continue
    }
    seen.push(accountHome)
    const transcriptPath = await input.resolveTranscript({
      providerSessionId: input.providerSessionId,
      accountHome,
      launchEnv: input.launchEnv,
      workspaceCwd: input.workspaceCwd
    })
    if (transcriptPath) {
      return { accountHome, transcriptPath }
    }
  }
  // Wrong-home fallback silently turns resume into a blank chat under the old name.
  throw agentSessionRefusalError('agent_session_identity_required', {
    reason: 'transcriptNotFound'
  })
}
