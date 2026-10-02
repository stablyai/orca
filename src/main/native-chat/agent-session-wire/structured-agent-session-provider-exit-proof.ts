// What a cleanup or a stop proved about a provider child's exit, read from the adapter's typed
// verdicts: a failed acquisition rethrows with the verdict its cleanup reached, and a stop answers
// whether the provider root is gone.

import { isAgentSessionWireRefusalCode } from '../../../shared/agent-session-wire-refusals'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
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
    // A root exit the cleanup observed first-hand keeps its classification and its
    // provider diagnostic; the failure that triggered cleanup rides along as cause.
    throw cleanupError instanceof AgentSessionAcquisitionRootExitObservedError
      ? new AgentSessionAcquisitionRootExitObservedError(
          new AggregateError([cause, cleanupError], cleanupError.message)
        )
      : new AgentSessionAcquisitionExitUnprovenError(
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
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    isAgentSessionPreSpawnError(cause) ||
    (cause instanceof Error && isAgentSessionWireRefusalCode(cause.message))
  return classified ? cause : new AgentSessionAcquisitionExitProvenError(cause)
}

/** Whether a stop left the provider root gone. The lease follows the root, so a first-hand root
 *  exit or a processless child ends the session whatever its descendants did; any other
 *  failure still throws. */
export async function stopAgentSessionProviderRoot(stop: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await stop()) === true
  } catch (error) {
    if (
      error instanceof AgentSessionAcquisitionRootExitObservedError ||
      isAgentSessionPreSpawnError(error)
    ) {
      return true
    }
    throw error
  }
}
