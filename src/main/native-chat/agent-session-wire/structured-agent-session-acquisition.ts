import {
  beginStructuredForkAttempt,
  proveStructuredForkAcquisition,
  refuseStructuredForkAttempt
} from './structured-agent-session-fork-lifecycle'
import { isDeepStrictEqual } from 'node:util'
import { claudeRewindAcquisitionProofs } from './structured-rewind-claude-proof'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionAcquisitionExitAmbiguous,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'

/** A reservation with no process behind it is only a promise to spawn; the
 * adapter makes it real and the store then grants the writer. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{ record: AgentSessionRecord; acquisitionGeneration: string | null }> {
  const { store, rewind, now } = input
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
    const fork = await beginStructuredForkAttempt(input.store, record)
    const acquired = await input.adapter.acquire({
      ...(fork ? { fork } : {}),
      identity: journalIdentityFor(record, input.params),
      ...claudeRewindAcquisitionProofs({ store, record, rewind, now }),
      fence,
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(record.options ? { options: record.options } : {}),
      ...(input.eventSink ? { events: input.eventSink } : {})
    })
    const options = await readNativeSessionOptions({
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
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: proveStructuredForkAcquisition(record, acquired.link),
      now: input.now(),
      ...(options ? { options } : {})
    })
    return {
      record: proved,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      // Nothing spawned, so no provider session can exist: settle the attempt rather than strand it.
      await refuseStructuredForkAttempt(input.store, record, describeRefusal(error))
      throw error
    }
    try {
      return await rethrowAfterAgentSessionAcquisitionCleanup(
        input.adapter,
        record.sessionId,
        error
      )
    } catch (settled) {
      // Cleanup that PROVED a clean release leaves no provider session behind, so a fork attempt
      // that died past the spawn — a fork-history verification timeout, a restore refusal — can
      // settle too instead of wedging the turn forever. Anything ambiguous keeps `attempted` and
      // goes on refusing, because a second attempt could then mint a second child.
      const ambiguous = isAgentSessionAcquisitionExitAmbiguous(settled)
      if (!ambiguous) {
        await refuseStructuredForkAttempt(input.store, record, describeRefusal(settled))
      }
      if (record.fork) {
        // Which branch ran is the difference between a retryable fork and a wedged one, and it is
        // invisible from the client, which sees one sentence either way.
        console.warn(
          `[agent-session] fork acquisition failed for ${record.sessionId}: ` +
            `${ambiguous ? 'exit unproven, left attempted' : 'released cleanly, settled refused'}`,
          settled
        )
      }
      throw settled
    }
  }
}

function describeRefusal(error: unknown): string {
  const cause = error instanceof Error ? (error.cause ?? error) : error
  return cause instanceof Error && cause.message
    ? cause.message
    : 'agent_session_acquisition_failed'
}
