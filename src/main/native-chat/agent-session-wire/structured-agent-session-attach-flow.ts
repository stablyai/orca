import { settlePostAcquisitionAttachFailure } from './structured-agent-session-attach-failure'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from './structured-agent-session-failed-create-refusal'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
// The host supplies owner authority; this flow reserves, proves, and publishes the session.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  admitAttachOrRefuse,
  attachJournal,
  classifyStoreFailure,
  journalIdentityFor,
  reserveRequestFor,
  type AgentSessionAttachAuthority,
  type AgentSessionAttachParams,
  type AttachedJournal
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { acquireOwner } from './structured-agent-session-acquisition'
import {
  importAdoptedTranscript,
  prepareAdoptedTranscript
} from './structured-agent-session-adopted-import'
import {
  withAgentSessionCreatePhase,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  recordPhase?: AgentSessionCreatePhaseRecorder
  /** Publishes the journal before clients can send against the new owner. `acquiredOwner` is
   *  true only when this attach spawned the provider child, so a re-attach to a live one is not
   *  mistaken for a cold acquire. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null,
    acquiredOwner: boolean,
    providerChildPhase: StructuredAgentSessionProviderChildPhase
  ) => Promise<void> | void
  /** Host-owned provider sink, bound to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
  /** Closes and removes partial publication after journal attachment fails. */
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
  let acquiredOwner = false
  let providerChildPhase: StructuredAgentSessionProviderChildPhase = 'ready'
  let reservedRecord: AgentSessionRecord | null = null
  let unsupportedReservationSettlementAttempted = false
  let replayed = false
  let providerHistoryWindow: ProviderHistoryWindow | null = null
  const preparedTranscript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!preparedTranscript.ok) {
    return preparedTranscript
  }
  try {
    const reserved = await withAgentSessionCreatePhase('reserve_owner', input.recordPhase, () =>
      store.reserveOwner(
        reserveRequestFor({
          sessionId,
          params,
          authority: input.authority,
          callerKey: input.callerKey,
          fingerprint: admitted.fingerprint,
          now: input.now()
        })
      )
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
    // Sample provider history before a new child is acquired. Once acquireOwner
    // starts the child, the adapter's liveness signal intentionally becomes
    // conservative and an absent prompt can no longer prove non-delivery.
    providerHistoryWindow = await readProviderHistoryWindow({
      adapter: input.adapter,
      identity: journalIdentityFor(record, params),
      accountHome: record.accountHome,
      ownerAlreadyAdmitted: agentSessionLeaseAdmitsWriter(record.lease)
    })
    if (!agentSessionLeaseAdmitsWriter(record.lease)) {
      const acquired = await withAgentSessionCreatePhase('acquire_owner', input.recordPhase, () =>
        acquireOwner(input, record)
      )
      record = acquired.record
      acquisitionGeneration = acquired.acquisitionGeneration
      providerChildPhase = acquired.providerChildPhase
      acquiredOwner = true
    }
  } catch (error) {
    const spawnToken = reservedRecord?.lease.reservedSpawnToken
    if (reservedRecord && spawnToken && !unsupportedReservationSettlementAttempted) {
      // Settle processless proof and failed operation atomically.
      try {
        await store.settleFailedAcquisition({
          sessionId,
          fence: reservedRecord.lease.runtimeFence,
          spawnToken,
          callerKey: input.callerKey,
          operationId: params.envelope.clientOperationId,
          ...failedAcquisitionSettlement(error),
          now: input.now()
        })
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'agent session acquisition failure settlement failed'
        )
      }
    }
    return (
      failedAcquisitionRefusal(error) ?? {
        ok: false,
        refusal: classifyStoreFailure(
          error,
          store.getRecord(sessionId)?.lease.runtimeFence ?? null,
          store.getRecord(sessionId)
        )
      }
    )
  }

  let attached: AttachedJournal
  try {
    await input.beforeJournalOpen?.()
    attached = await attachJournal({
      record,
      params,
      journalRoot: input.journalRoot,
      adapter: input.adapter,
      providerHistoryWindow
    })
    await importAdoptedTranscript(params, attached, record, preparedTranscript.items)
    await input.onAttached(attached, acquisitionGeneration, acquiredOwner, providerChildPhase)
    await store.recordOperationOutcome({
      callerKey: input.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'succeeded', sessionId }
    })
  } catch (error) {
    return settlePostAcquisitionAttachFailure(input, record, error)
  }

  const fence = record.lease.runtimeFence
  const tabId = store.getSessionTabId(sessionId)
  return {
    ok: true,
    replayed,
    fence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence,
      page: readAgentSessionHydrationPage(attached.journal, fence),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds,
      ...(tabId ? { tabId } : {})
    }
  }
}

async function readProviderHistoryWindow(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  accountHome: AgentSessionRecord['accountHome']
  ownerAlreadyAdmitted: boolean
}): Promise<ProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.accountHome })
  } catch {
    return null
  }
  // A lease that was already live may belong to a provider child this process
  // has not indexed yet. Preserve the safe unknown outcome in that case.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
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
