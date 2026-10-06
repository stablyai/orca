// What a cleanup or a stop proved about a provider child's exit, read from the adapter's typed
// verdicts: a failed acquisition rethrows with the verdict its cleanup reached, and a stop answers
// whether the provider root is gone.

import { isAgentSessionWireRefusalCode } from '../../../shared/agent-session-wire-refusals'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionProviderKilledError,
  isAgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'

export async function rethrowAfterAgentSessionAcquisitionCleanup(
  adapter: Pick<StructuredAgentSessionAdapter, 'releaseAcquisition'>,
  sessionId: string,
  cause: unknown
): Promise<never> {
  let released: boolean
  try {
    released = (await adapter.releaseAcquisition?.({ sessionId })) === true
  } catch (cleanupError) {
    // A root exit the cleanup observed first-hand, or a kill it delivered, keeps its
    // classification and its provider diagnostic; the failure that triggered cleanup rides along.
    if (cleanupError instanceof AgentSessionAcquisitionRootExitObservedError) {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new AggregateError([cause, cleanupError], cleanupError.message)
      )
    }
    if (cleanupError instanceof AgentSessionProviderKilledError) {
      throw new AgentSessionProviderKilledError(
        new AggregateError([cause, cleanupError], cleanupError.message)
      )
    }
    throw new AgentSessionAcquisitionExitUnprovenError(
      new AggregateError([cause, cleanupError], 'agent session acquisition cleanup failed')
    )
  }
  if (released) {
    throw provenExitAcquisitionFailure(cause)
  }
  throw new AgentSessionAcquisitionExitUnprovenError(cause)
}

/** A failure whose child cleanup proved gone. One that already names its own verdict — a
 *  refusal, a typed exit proof, or a host store code — keeps it. */
function provenExitAcquisitionFailure(cause: unknown): unknown {
  const classified =
    cause instanceof AgentSessionAcquisitionRefusal ||
    cause instanceof AgentSessionAcquisitionRootExitObservedError ||
    cause instanceof AgentSessionProviderKilledError ||
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    isAgentSessionPreSpawnError(cause) ||
    (cause instanceof Error && isAgentSessionWireRefusalCode(cause.message))
  return classified ? cause : new AgentSessionAcquisitionExitProvenError(cause)
}

/** What a stop established about the provider: its root seen gone; `killed`, Orca's kill reached
 *  the process that writes the conversation but no exit was seen; or `unproven`. */
export type AgentSessionProviderStop = 'exited' | 'killed' | 'unproven'

/** What a stop left of the provider. The lease follows the root, so a first-hand root exit or a
 *  processless child ends the session whatever its descendants did; a delivered kill ends it too,
 *  since nothing it reached can write again. A descendant left unconfirmed, or bookkeeping that
 *  failed after the proven exit, is only `report`ed. Any other failure throws. */
export async function stopAgentSessionProviderRoot(
  stop: () => Promise<boolean>,
  report?: (error: Error) => void
): Promise<AgentSessionProviderStop> {
  try {
    return (await stop()) === true ? 'exited' : 'unproven'
  } catch (error) {
    if (
      error instanceof AgentSessionAcquisitionRootExitObservedError ||
      error instanceof AgentSessionAcquisitionExitProvenError
    ) {
      report?.(error)
      return 'exited'
    }
    if (error instanceof AgentSessionProviderKilledError) {
      return 'killed'
    }
    if (isAgentSessionPreSpawnError(error)) {
      return 'exited'
    }
    throw error
  }
}
