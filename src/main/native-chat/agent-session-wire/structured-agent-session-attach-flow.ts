import { refuse } from '../../../shared/agent-session-wire-refusals'
import { settlePostAcquisitionAttachFailure } from './structured-agent-session-attach-failure'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement,
  preSpawnFailureInWords
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
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

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
  /** The conversation's own open journal, which the attach adopts: it never opens one itself. */
  openConversation: (record: AgentSessionRecord) => Promise<AgentSessionJournal>
  /** A failure after acquisition released the session's acquisition; `cause` is that failure and
   *  `rootGone` whether the release saw the provider root go. */
  onAcquisitionReleased?: (cause: unknown, verdict: { rootGone: boolean }) => void
  /** The error an acquisition failed with, for a host-side reader of the provider's words; the
   *  refusal never carries them. */
  onAcquisitionFailed?: (error: unknown) => void
}

export async function performAttach(
  input: AttachFlowInput
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, store } = input
  const unsupported = (): AgentSessionMutationResult<AgentSessionAttachResult> => ({
    ok: false,
    refusal: refuse(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      'This execution host cannot create the requested structured agent session.'
    )
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
    const wording = {
      record: reservedRecord ?? store.getRecord(sessionId),
      newSession: !params.providerHandle
    }
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
          ...failedAcquisitionSettlement(error, wording),
          now: input.now()
        })
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'agent session acquisition failure settlement failed'
        )
      }
    }
    input.onAcquisitionFailed?.(error)
    const failed = failedAcquisitionRefusal(error, wording)
    const thrown = failed ? error : preSpawnFailureInWords(error, wording)
    if (failed || thrown !== error) {
      // The answer carries only its sentence, so what failed is kept here.
      console.warn('[agent-session] provider start failed:', error)
    }
    return (
      failed ?? {
        ok: false,
        refusal: classifyStoreFailure(
          thrown,
          store.getRecord(sessionId)?.lease.runtimeFence ?? null,
          store.getRecord(sessionId)
        )
      }
    )
  }

  let attached: AttachedJournal
  try {
    await input.beforeJournalOpen?.()
    attached = await attachJournal({ record, openConversation: input.openConversation })
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
      // No host decides delivery after a restart any more; kept because the wire type requires it.
      unconfirmedClientMessageIds: [],
      ...(tabId ? { tabId } : {})
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
        details: { reason: 'hostUnsupported' },
        message: 'Structured session support changed before the provider could start.'
      },
      exitProof: 'processless',
      now: input.now()
    })
  } catch (error) {
    throw new AggregateError([error], 'agent session unsupported reservation settlement failed')
  }
}
