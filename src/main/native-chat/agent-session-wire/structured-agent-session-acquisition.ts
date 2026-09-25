import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup,
  type StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'

/** A reservation with no process behind it is only a promise to spawn; the
 * adapter makes it real and the store then grants the writer. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{
  record: AgentSessionRecord
  acquisitionGeneration: string | null
  providerChildPhase: StructuredAgentSessionProviderChildPhase
}> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  // Pre-spawn proof is single-use: this retry may create a child after the durable clear.
  try {
    try {
      record = await input.store.setReservationProcesslessProof({
        sessionId: record.sessionId,
        fence,
        spawnToken,
        processlessAt: null,
        now: input.now()
      })
      await input.onAcquiring?.()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const acquired = await input.adapter.acquire({
      identity: journalIdentityFor(record, input.params),
      fence,
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(record.options ? { options: record.options } : {}),
      ...(input.eventSink ? { events: input.eventSink } : {}),
      ...(input.recordPhase ? { recordPhase: input.recordPhase } : {})
    })
    const providerChildPhase = acquired.providerChildPhase ?? 'ready'
    // A starting child has proven nothing: the record keeps the reservation's saved options as
    // intent, never a catalog guess, and the `started` event persists what the child reports.
    const options =
      providerChildPhase === 'starting'
        ? undefined
        : await withAgentSessionCreatePhase('restore_options', input.recordPhase, () =>
            readNativeSessionOptions({
              adapter: input.adapter,
              sessionId: record.sessionId,
              fence,
              ...(record.options ? { priorOptions: record.options } : {})
            })
          )
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
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: acquired.link,
      now: input.now(),
      ...(options ? { options } : {})
    })
    return {
      record: proved,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      providerChildPhase
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
