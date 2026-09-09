// Adopting an Agent Session History row into a brand-new structured chat.
//
// Kept out of the runtime class files because those are `@ts-nocheck`: this decides which
// credential directory a provider child will launch against and which file gets imported into a
// journal, and a call site written there would compile however wrong it was. The runtime hands over
// the facts it owns — the account homes it recognises, the records it holds — and this decides.

import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-journal-types'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'

export type StructuredAgentSessionAdoptionOwnership = {
  sessionId: string
  provider: 'claude' | 'codex'
  providerSessionId: string
  lease: AgentSessionLease
}

export type StructuredAgentSessionAdoption = {
  /** The account home the transcript was actually found under — never a client-supplied path. */
  accountHomePath: string
  transcriptPath: string
}

export type CommittedStructuredAgentSessionAdoptionReplay = {
  record: AgentSessionRecord
  providerHandle: Exclude<AgentSessionProviderHandle, { kind: 'opaque' }>
}

/** Exact committed-operation identity; attach still validates its fingerprint. */
export function findCommittedStructuredAgentSessionAdoptionReplay(input: {
  agent: 'claude' | 'codex'
  providerSessionId: string
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
  const providerSessionId =
    adopted.handle.provider === 'codex' ? adopted.handle.threadId : adopted.handle.sessionId
  if (providerSessionId !== input.providerSessionId) {
    return null
  }
  return {
    record,
    providerHandle:
      adopted.handle.provider === 'codex'
        ? { kind: 'codex', threadId: adopted.handle.threadId }
        : {
            kind: 'claude',
            sessionId: adopted.handle.sessionId,
            leafUuid: adopted.handle.leafUuid
          }
  }
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
  agent: 'claude' | 'codex'
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
  return new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
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
  agent: 'claude' | 'codex'
  providerSessionId: string
  candidateAccountHomes: readonly string[]
  resolveTranscript: (args: {
    agent: 'claude' | 'codex'
    providerSessionId: string
    accountHomePath: string
  }) => Promise<string | null>
}): Promise<StructuredAgentSessionAdoption> {
  const seen = new Set<string>()
  for (const accountHomePath of input.candidateAccountHomes) {
    const trimmed = accountHomePath.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    const transcriptPath = await input.resolveTranscript({
      agent: input.agent,
      providerSessionId: input.providerSessionId,
      accountHomePath: trimmed
    })
    if (transcriptPath) {
      return { accountHomePath: trimmed, transcriptPath }
    }
  }
  // Refuse rather than fall back to the default home. Resuming under a home that does not hold the
  // conversation is how a "resume" silently becomes a blank chat wearing the old chat's name.
  throw new Error('agent_session_identity_required')
}
