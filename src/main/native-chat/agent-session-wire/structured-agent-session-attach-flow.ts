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
  journalIdentityFor,
  reserveRequestFor,
  type AgentSessionAttachAuthority,
  type AgentSessionAttachParams,
  type AttachedJournal
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  adapterSupportsCreateIfDeclared,
  hostCanStartRecord
} from './structured-agent-session-provider-support'
import type { StructuredAgentRegistry } from './structured-agent-registry'
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
import type { PlacedProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import { sampleProviderHistoryWindow } from './structured-agent-session-history-sample'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'
import type { StructuredAgentSessionStartupProgress } from './structured-agent-session-startup-attempt'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  /** What decides whether this build may start a record's agent at all (`agentDrivesSession`). */
  agents: Pick<StructuredAgentRegistry, 'definition'>
  logger: StructuredAgentSessionLogger
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  recordPhase?: AgentSessionCreatePhaseRecorder
  /** Aborted when a close, or a Stop admitted now, must not wait behind this attach's acquire. */
  acquireSignal?: AbortSignal
  /** The attempt this attach's acquire runs under, minted before the adapter is called; what it
   *  answers learns of the child's spawn and output. */
  onStartupAttempt?: (
    attempt: StructuredAgentSessionStartupAttempt
  ) => StructuredAgentSessionStartupProgress
  /** The conversation's option revision, which the child's reports are stamped with. */
  optionRevision: () => number
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
  // Every start of every agent passes here, so this is where a record this build cannot drive (its
  // transport or account variable is not its agent's) is refused; reading it never is.
  const supported = (record: AgentSessionRecord | null) =>
    record === null
      ? input.agents.definition(params.agent) !== null &&
        adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)
      : hostCanStartRecord(input, record)
  // Ensure/recovery bypass create-intent, so recheck before reserving or spawning.
  if (!supported(store.getRecord(sessionId))) {
    return unsupported()
  }

  let record: AgentSessionRecord
  let acquisitionGeneration: string | null = null
  let acquiredOwner = false
  let providerChildPhase: StructuredAgentSessionProviderChildPhase = 'ready'
  let reservedRecord: AgentSessionRecord | null = null
  let unsupportedReservationSettlementAttempted = false
  let replayed = false
  let providerHistoryWindow: PlacedProviderHistoryWindow | null = null
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
    if (!supported(record)) {
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
    providerHistoryWindow = await sampleProviderHistoryWindow({
      adapter: input.adapter,
      identity: journalIdentityFor(record, params),
      record,
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
      input.logger.warn('starting the provider failed', {
        scope: 'provider-start',
        sessionId,
        error
      })
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
    attached = await attachJournal({
      record,
      openConversation: input.openConversation,
      logger: input.logger,
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
