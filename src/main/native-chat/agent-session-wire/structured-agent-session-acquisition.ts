import { isDeepStrictEqual } from 'node:util'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-provider-exit-proof'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import { mintStructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt'
import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'

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

/** Bookkeeping: a failure is logged, never the proven start's. */
function handOverStartCatalogListing(
  input: AttachFlowInput,
  sessionId: string,
  listing: AgentModelCatalogLiveListing
): void {
  try {
    input.onStartCatalogListing?.(listing)
  } catch (error) {
    input.logger.warn('saving what a started provider listed failed', {
      scope: 'provider-started-catalog',
      sessionId,
      error
    })
  }
}

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
    const providerChildPhase = acquired.providerChildPhase ?? 'ready'
    // A starting child has proven nothing: the record keeps the reservation's saved options as
    // intent, never a catalog guess, and the `started` event persists what the child reports.
    const options =
      providerChildPhase === 'starting'
        ? undefined
        : await withAgentSessionCreatePhase('restore_options', input.recordPhase, async () => {
            const read = {
              sessionId: record.sessionId,
              fence,
              ...(record.options ? { priorOptions: record.options } : {})
            }
            // Still inside the start, so the limit or a Stop ends a read the provider never answers.
            return waitForPromiseWithSignal(
              Promise.resolve(
                input.adapter.readAcquisitionOptions
                  ? input.adapter.readAcquisitionOptions(read)
                  : readNativeSessionOptions({ adapter: input.adapter, ...read })
              ),
              input.acquireSignal
            )
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
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: acquired.link,
      now: input.now(),
      ...(options ? { options } : {})
    })
    if (providerChildPhase === 'ready' && acquired.catalogListing) {
      handOverStartCatalogListing(input, record.sessionId, acquired.catalogListing)
    }
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
