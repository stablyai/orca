import { refuse } from '../../../shared/agent-session-wire-refusals'
import {
  settlePostAcquisitionAttachFailure,
  settleUnsupportedReservation
} from './structured-agent-session-attach-failure'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement,
  preSpawnFailureInWords
} from './structured-agent-session-failed-create-refusal'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
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
import { withPublishedWork } from './agent-session-published-work'
import { heldStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
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
import { readProviderHistoryWindow } from './structured-agent-session-provider-history-window'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'
import type { StructuredAgentSessionStartupProgress } from './structured-agent-session-startup-attempt'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  heldStructuredAgentSessionAttachLock,
  type StructuredAgentSessionAttachLock
} from './structured-agent-session-attach-lock'

export type AttachedOwner = 'acquired' | 'kept' | 'none'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  agents: Pick<StructuredAgentRegistry, 'definition'>
  logger: StructuredAgentSessionLogger
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  recordPhase?: AgentSessionCreatePhaseRecorder
  /** Stop/close cancellation must not wait behind acquisition. */
  acquireSignal?: AbortSignal
  /** Absent means the caller already holds serialization. */
  lock?: StructuredAgentSessionAttachLock
  /** Transient catalog used to validate new-chat choices. */
  models?: Parameters<typeof reserveRequestFor>[0]['models']
  startupAttemptId?: string
  /** Mint before acquisition so spawn callbacks identify the same registered attempt. */
  onStartupAttempt?: (
    attempt: StructuredAgentSessionStartupAttempt
  ) => StructuredAgentSessionStartupProgress
  startupOptions?: Readonly<Record<string, string>>
  launchPermissionMode?: (
    record: AgentSessionRecord
  ) => Promise<AgentChatPermissionMode | undefined>
  /** Publish journal before new-owner sends; distinguish newly starting, retained live and resting owners. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null,
    owner: AttachedOwner
  ) => Promise<void> | void
  /** Wait outside commits for sink drains/provider reads. */
  beforePublish?: (owner: AttachedOwner) => Promise<void>
  /** Commit outcome before indexing the child as session-owned. */
  onPublish?: (attached: AttachedJournal, recordOutcome: () => Promise<void>) => Promise<void>
  eventSink?: StructuredAgentSessionEventSink
  /** Prevent acquisition-window events from reaching superseded journals. */
  onAcquiring?: () => Promise<void> | void
  beforeJournalOpen?: () => Promise<void> | void
  /** Adopt the conversation’s journal; attach never owns its open. */
  openConversation: (record: AgentSessionRecord) => Promise<AgentSessionJournal>
  /** Report release failure cause and whether provider-root exit was observed. */
  onAcquisitionReleased?: (cause: unknown, verdict: { rootGone: boolean }) => void
  /** Provider words stay host-side, outside refusals. */
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
  // All starts validate agent storage identity; unsupported records remain readable.
  const supported = (record: AgentSessionRecord | null) =>
    record === null
      ? input.agents.definition(params.agent) !== null &&
        adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)
      : hostCanStartRecord(input, record)
  // Ensure/recovery bypass create intent, so recheck before effects.
  if (!supported(store.getRecord(sessionId))) {
    return unsupported()
  }

  let record: AgentSessionRecord
  let acquisitionGeneration: string | null = null
  let owner: AttachedOwner = 'kept'
  let reservedRecord: AgentSessionRecord | null = null
  let unsupportedReservationSettlementAttempted = false
  let replayed = false
  let providerHistoryWindow: ProviderHistoryWindow | null = null
  const lock = input.lock ?? heldStructuredAgentSessionAttachLock(input.acquireSignal)
  const preparedTranscript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!preparedTranscript.ok) {
    return preparedTranscript
  }
  try {
    const reserved = await withAgentSessionCreatePhase('reserve_owner', input.recordPhase, () =>
      lock.commit(() =>
        store.reserveOwner(
          reserveRequestFor({
            sessionId,
            params,
            authority: input.authority,
            callerKey: input.callerKey,
            fingerprint: admitted.fingerprint,
            now: input.now(),
            models: input.models
          })
        )
      )
    )
    record = reserved.record
    replayed = reserved.disposition === 'replayed'
    // Recheck support after reservation; settle pending reservations invalidated by drift.
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
    // Read history before spawn; a live child makes absent prompts inconclusive for non-delivery.
    providerHistoryWindow = await lock.wait(
      readProviderHistoryWindow({
        adapter: input.adapter,
        identity: journalIdentityFor(record, params),
        accountHome: record.accountHome,
        ownerAlreadyAdmitted: agentSessionLeaseAdmitsWriter(record.lease)
      })
    )
    if (agentSessionLeaseAdmitsWriter(record.lease)) {
      // Keep the existing live owner.
    } else if (replayed && reserved.operationRow.outcome.status === 'succeeded') {
      // Successful creates replay at rest after their child ends; next send starts another.
      owner = 'none'
    } else {
      const acquired = await withAgentSessionCreatePhase('acquire_owner', input.recordPhase, () =>
        acquireOwner(input, record)
      )
      record = acquired.record
      acquisitionGeneration = acquired.acquisitionGeneration
      owner = 'acquired'
    }
  } catch (error) {
    const wording = {
      record: reservedRecord ?? store.getRecord(sessionId),
      newSession: !params.providerHandle
    }
    const spawnToken = reservedRecord?.lease.reservedSpawnToken
    if (reservedRecord && spawnToken && !unsupportedReservationSettlementAttempted) {
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
    const acquired = record
    attached = await lock.commit(async () => {
      await input.beforeJournalOpen?.()
      const journal = await attachJournal({
        record: acquired,
        params,
        adapter: input.adapter,
        openConversation: input.openConversation,
        providerHistoryWindow
      })
      await importAdoptedTranscript(params, journal, acquired, preparedTranscript.items)
      await input.onAttached(journal, acquisitionGeneration, owner)
      return journal
    })
    await lock.wait(input.beforePublish?.(owner) ?? Promise.resolve())
    const recordOutcome = () =>
      store.recordOperationOutcome({
        callerKey: input.callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: { status: 'succeeded', sessionId }
      })
    await lock.commit(() =>
      input.onPublish ? input.onPublish(attached, recordOutcome) : recordOutcome()
    )
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
      page: withPublishedWork(
        readAgentSessionHydrationPage(attached.journal, fence),
        heldStructuredAgentSessionCurrentWork(store, sessionId, attached.journal, undefined)
      ),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds,
      ...(tabId ? { tabId } : {})
    }
  }
}
