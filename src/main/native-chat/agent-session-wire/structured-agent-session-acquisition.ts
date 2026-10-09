import { isDeepStrictEqual } from 'node:util'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-provider-exit-proof'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { mintStructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt'

/** The same process, whatever Orca runtime the store stamped on its record (`runtime`): that stamp
 *  is about who holds the process, not which process it is. */
function sameOwnerProcess(
  stored: AgentSessionProcessIdentity,
  acquired: AgentSessionProcessIdentity
): boolean {
  const { runtime: _storedRuntime, ...storedProcess } = stored
  const { runtime: _acquiredRuntime, ...acquiredProcess } = acquired
  return isDeepStrictEqual(storedProcess, acquiredProcess)
}

/** A reservation with no process behind it is only a promise to spawn; the
 * adapter makes it real and the store then grants the writer. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{
  record: AgentSessionRecord
  acquisitionGeneration: string | null
}> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  try {
    try {
      await input.onAcquiring?.()
      // A close or Stop that landed while the attach was still reconciling launches nothing.
      input.acquireSignal?.throwIfAborted()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const attempt = mintStructuredAgentSessionStartupAttempt({
      record,
      identity: journalIdentityFor(record, input.params),
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(input.eventSink ? { events: input.eventSink } : {}),
      ...(input.acquireSignal ? { signal: input.acquireSignal } : {}),
      optionRevision: input.optionRevision
    })
    const progress = input.onStartupAttempt?.(attempt)
    const acquired = await input.adapter.acquire({
      ...attempt,
      ...(progress ? { onOutput: progress.output } : {}),
      ...(input.recordPhase ? { recordPhase: input.recordPhase } : {}),
      onSpawned: async (process) => {
        progress?.spawned()
        record = await input.store.commitProcessIdentity({
          sessionId: record.sessionId,
          fence,
          process,
          now: input.now()
        })
      }
    })
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!sameOwnerProcess(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    // The process owns the lease now; a handle the provider answers with is recorded on `started`.
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      ...(acquired.link ? { link: acquired.link } : {}),
      now: input.now()
    })
    return { record: proved, acquisitionGeneration: acquired.acquisitionGeneration ?? null }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
