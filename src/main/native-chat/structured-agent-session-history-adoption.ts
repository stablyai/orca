// Adopting an Agent Session History row into a brand-new structured chat.
//
// Credential homes and transcripts must come from runtime-owned facts, never client-supplied paths.

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink,
  StructuredAgentId
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'

export type StructuredAgentSessionAdoptionOwnership = {
  sessionId: string
  workspaceId: string
  /** Any agent's chat may hold the conversation, though only one with an importer adopts. */
  provider: StructuredAgentId
  providerSessionId: string
  lease: AgentSessionLease
}

export type StructuredAgentSessionAdoption = {
  /** The account home the transcript was actually found under — never a client-supplied one. */
  accountHome: AgentSessionAccountHome
  transcriptPath: string
}

export type CommittedStructuredAgentSessionAdoptionReplay = {
  record: AgentSessionRecord
  providerHandle: AgentSessionProviderHandle
}

/** Exact committed-operation identity; attach still validates its fingerprint. */
export function findCommittedStructuredAgentSessionAdoptionReplay(input: {
  agent: StructuredAgentId
  providerSessionId: string
  /** The Session History row id a link of the agent's handle chain shows as. */
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

/**
 * A conversation has exactly one writer. Codex takes no lock of its own: a second app-server holding
 * the same thread never errors, it loads history once and then diverges, and the rollout ends up
 * recording a conversation that never happened. So the refusal is the correctness guard, and it has
 * to be able to tell "someone else owns this" from "this very operation owns it".
 *
 * @param selfSessionId the structured session this create is reserving. A retry of a committed
 * create re-runs every pre-commit check, and by then the record it created is itself in the
 * ownership index — without this exemption the replay refuses instead of replaying.
 */
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
        owner.provider === input.agent &&
        owner.providerSessionId === input.providerSessionId
    ) ?? null
  )
}

/** Mirrors the legacy PTY resume's refusal vocabulary: a conversation with an admitted writer is a
 *  conflict, one without is an unknown owner. Neither ever admits a second writer. */
export function structuredAdoptionConflictError(
  ownership: StructuredAgentSessionAdoptionOwnership
): Error {
  return agentSessionRefusalError(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown',
    {
      reason: 'conversationHeldElsewhere',
      owner: { sessionId: ownership.sessionId, workspaceId: ownership.workspaceId }
    }
  )
}

/**
 * Resolve which recognised account home holds this conversation, by finding its transcript.
 *
 * The client names only the conversation. Everything else is derived here: `agentSession.create` is
 * reachable by paired mobile clients, so a client-supplied account home would choose the credential
 * directory the provider child launches against, and a client-supplied transcript path would choose
 * which file this host reads into a journal.
 *
 * Candidates are tried in order and the FIRST hit wins, so the caller must order them by preference
 * (selected account before the system default).
 */
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
  // Refuse rather than fall back to the default home. Resuming under a home that does not hold the
  // conversation is how a "resume" silently becomes a blank chat wearing the old chat's name.
  throw agentSessionRefusalError('agent_session_identity_required', {
    reason: 'transcriptNotFound'
  })
}
