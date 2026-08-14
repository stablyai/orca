// The attach transition end to end: reserve the lease, make the reservation
// real, open the journal.
//
// Split out of the host so the sequence reads in one place. The host still owns
// the decisions that must not be client-supplied — the spawn token, the claim
// key, the owner probe — and passes them in.

import { isDeepStrictEqual } from 'node:util'
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
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { isAgentSessionPreSpawnError } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { readNativeHandoffSessionOptions } from './structured-agent-session-handoff-options'

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
  onAttached: (attached: AttachedJournal) => void
  /** Handed to the adapter so it can journal what the provider streams. The
   *  host owns it and binds it to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
}

export async function performAttach(
  input: AttachFlowInput
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, store } = input
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }

  let record: AgentSessionRecord
  let reservedRecord: AgentSessionRecord | null = null
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
    reservedRecord = record
    replayed = reserved.disposition === 'replayed'
    if (!agentSessionLeaseAdmitsWriter(record.lease)) {
      record = await acquireOwner(input, record)
    }
  } catch (error) {
    if (reservedRecord && isAgentSessionPreSpawnError(error)) {
      const spawnToken = reservedRecord.lease.reservedSpawnToken
      if (spawnToken) {
        const processlessAt = input.now()
        await store.setReservationProcesslessProof({
          sessionId,
          fence: reservedRecord.lease.runtimeFence,
          spawnToken,
          processlessAt,
          now: processlessAt
        })
      }
    }
    return {
      ok: false,
      refusal: classifyStoreFailure(error, store.getRecord(sessionId)?.lease.runtimeFence ?? null)
    }
  }

  await input.beforeJournalOpen?.()
  const attached = await attachJournal({
    record,
    params,
    journalRoot: input.journalRoot,
    adapter: input.adapter
  })
  input.onAttached(attached)
  await store.recordOperationOutcome({
    callerKey: input.callerKey,
    operationId: params.envelope.clientOperationId,
    outcome: { status: 'succeeded', sessionId }
  })

  const fence = record.lease.runtimeFence
  return {
    ok: true,
    replayed,
    fence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence,
      snapshot: attached.journal.snapshot(),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds
    }
  }
}

/** A reservation with no process behind it is only a promise to spawn; the
 *  adapter makes it real and the store then grants the writer. */
async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<AgentSessionRecord> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  // Pre-spawn proof is single-use: this retry may create a child after the durable clear.
  record = await input.store.setReservationProcesslessProof({
    sessionId: record.sessionId,
    fence,
    spawnToken,
    processlessAt: null,
    now: input.now()
  })
  await input.onAcquiring?.()
  const acquired = await input.adapter.acquire({
    identity: journalIdentityFor(record, input.params),
    fence,
    // Retries must recover the original reservation, not mint a second child.
    spawnToken,
    ...(record.options ? { options: record.options } : {}),
    ...(input.eventSink ? { events: input.eventSink } : {})
  })
  try {
    const options = await readNativeHandoffSessionOptions({
      adapter: input.adapter,
      sessionId: record.sessionId,
      fence,
      ...(record.options ? { priorOptions: record.options } : {})
    })
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!isDeepStrictEqual(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    return await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: acquired.link,
      now: input.now(),
      ...(options ? { options } : {})
    })
  } catch (error) {
    try {
      await input.adapter.releaseAcquisition?.({ sessionId: record.sessionId })
    } catch {
      // Preserve the lease failure; cleanup is best-effort and idempotent.
    }
    throw error
  }
}
