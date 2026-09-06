// The attach transition end to end: reserve the lease, make the reservation
// real, open the journal.
//
// Split out of the host so the sequence reads in one place. The host still owns
// the decisions that must not be client-supplied — the spawn token, the claim
// key, the owner probe — and passes them in.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  admitAttachOrRefuse,
  attachJournal,
  classifyStoreFailure,
  reserveRequestFor,
  type AgentSessionAttachAuthority,
  type AgentSessionAttachParams,
  type AttachedJournal
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionRefusal,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { acquireOwner } from './structured-agent-session-acquisition'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  /** Registers the opened journal and fans out to subscribers before the caller
   *  sees the result, so no client can send against a session the host has not
   *  finished publishing. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null
  ) => Promise<void> | void
  /** Handed to the adapter so it can journal what the provider streams. The
   *  host owns it and binds it to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
  /** Removes any partial host publication after journal attachment fails, and
   *  closes the journal handle of the map entry it drops. Awaited: see eviction. */
  onAttachFailed?: () => Promise<void>
}

export async function performAttach(
  input: AttachFlowInput
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, store } = input
  const unsupported = (): AgentSessionMutationResult<AgentSessionAttachResult> => ({
    ok: false,
    refusal: {
      code: 'structured_agent_session_unsupported',
      message: 'This execution host cannot create the requested structured agent session.'
    }
  })
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  // Ensure/recovery bypass create-intent, so recheck before reserving or spawning.
  if (!adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)) {
    return unsupported()
  }

  let record: AgentSessionRecord
  let acquisitionGeneration: string | null = null
  let reservedRecord: AgentSessionRecord | null = null
  let unsupportedReservationSettlementAttempted = false
  let replayed = false
  try {
    const reserved = await store.reserveOwner(
      reserveRequestFor({
        sessionId,
        params,
        authority: input.authority,
        callerKey: input.callerKey,
        fingerprint: admitted.fingerprint,
        now: input.now()
      })
    )
    record = reserved.record
    replayed = reserved.disposition === 'replayed'
    // Capability can change while the durable reservation is in flight. Recheck
    // every reservation at its effect boundary so it cannot bypass the support
    // gate, and release a pending reservation that support drift invalidated.
    reservedRecord = record
    if (!adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)) {
      if (
        record.lease.claimStatus === 'reserved' &&
        record.lease.handoffStage === 'new-owner-proving' &&
        record.lease.reservedSpawnToken
      ) {
        unsupportedReservationSettlementAttempted = true
        await settleUnsupportedReservation(input, record)
      }
      return unsupported()
    }
    if (
      replayed &&
      reserved.operationRow.outcome.status !== 'pending' &&
      reserved.operationRow.outcome.status !== 'succeeded'
    ) {
      const replay = resolveAgentSessionReplayOutcome({
        operationId: params.envelope.clientOperationId,
        outcome: reserved.operationRow.outcome,
        reconstruct: () => null
      })
      if (replay.decision === 'refuse') {
        return { ok: false, refusal: replay.refusal }
      }
    }
    if (!agentSessionLeaseAdmitsWriter(record.lease)) {
      const acquired = await acquireOwner(input, record)
      record = acquired.record
      acquisitionGeneration = acquired.acquisitionGeneration
    }
  } catch (error) {
    const spawnToken = reservedRecord?.lease.reservedSpawnToken
    if (reservedRecord && spawnToken && !unsupportedReservationSettlementAttempted) {
      // A pre-spawn failure is its own processless proof; the settlement records the
      // evidence and the failed operation in one durable transaction.
      const exitProof = isAgentSessionPreSpawnError(error)
        ? 'processless'
        : error instanceof AgentSessionAcquisitionExitUnprovenError
          ? 'unproven'
          : error instanceof AgentSessionAcquisitionRootExitObservedError
            ? 'root-exit-observed'
            : 'exit-proven'
      const outcome =
        error instanceof AgentSessionAcquisitionExitUnprovenError
          ? {
              status: 'failed' as const,
              code: 'agent_session_ownership_unknown',
              message: error.message
            }
          : error instanceof AgentSessionAcquisitionRefusal
            ? {
                status: 'failed' as const,
                code: error.code,
                message: error.message
              }
            : {
                status: 'failed' as const,
                code: 'agent_session_operation_invalid',
                message: error instanceof Error ? error.message : String(error)
              }
      try {
        await store.settleFailedAcquisition({
          sessionId,
          fence: reservedRecord.lease.runtimeFence,
          spawnToken,
          callerKey: input.callerKey,
          operationId: params.envelope.clientOperationId,
          outcome,
          exitProof,
          now: input.now()
        })
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'agent session acquisition failure settlement failed'
        )
      }
    }
    if (error instanceof AgentSessionAcquisitionRefusal) {
      return { ok: false, refusal: { code: error.code, message: error.message } }
    }
    return {
      ok: false,
      refusal: classifyStoreFailure(
        error,
        store.getRecord(sessionId)?.lease.runtimeFence ?? null,
        store.getRecord(sessionId)
      )
    }
  }

  let attached: AttachedJournal
  try {
    await input.beforeJournalOpen?.()
    attached = await attachJournal({
      record,
      params,
      journalRoot: input.journalRoot,
      adapter: input.adapter
    })
    await input.onAttached(attached, acquisitionGeneration)
    await store.recordOperationOutcome({
      callerKey: input.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'succeeded', sessionId }
    })
  } catch (error) {
    return settlePostAcquisitionAttachFailure(input, record, error)
  }

  const fence = record.lease.runtimeFence
  return {
    ok: true,
    replayed,
    fence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence,
      page: readAgentSessionHydrationPage(attached.journal, fence),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds
    }
  }
}

async function settleUnsupportedReservation(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<void> {
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    return
  }
  try {
    await input.store.settleFailedAcquisition({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken,
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'structured_agent_session_unsupported',
        message: 'Structured session support changed before the provider could start.'
      },
      exitProof: 'processless',
      now: input.now()
    })
  } catch (error) {
    throw new AggregateError([error], 'agent session unsupported reservation settlement failed')
  }
}

async function settlePostAcquisitionAttachFailure(
  input: AttachFlowInput,
  record: AgentSessionRecord,
  cause: unknown
): Promise<never> {
  let cleanupError: unknown = cause
  let exitProof: 'exit-proven' | 'root-exit-observed' | 'unproven' = 'unproven'
  try {
    await rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, cause)
  } catch (error) {
    cleanupError = error
    exitProof =
      error instanceof AgentSessionAcquisitionExitUnprovenError
        ? 'unproven'
        : error instanceof AgentSessionAcquisitionRootExitObservedError
          ? 'root-exit-observed'
          : 'exit-proven'
  }
  // Why: the close is awaited so the map entry is gone only once its handle is
  // released, but a failed close must not also cost the store settlement below.
  await Promise.resolve(input.onAttachFailed?.()).catch(() => undefined)
  try {
    await input.store.settleFailedPostAcquisitionAttachment({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken: record.lease.reservedSpawnToken ?? '',
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'agent_session_operation_invalid',
        message: cause instanceof Error ? cause.message : String(cause)
      },
      exitProof,
      now: input.now()
    })
  } catch (settlementError) {
    throw new AggregateError(
      [cleanupError, settlementError],
      'agent session post-acquisition attachment failure settlement failed'
    )
  }
  throw cleanupError
}
