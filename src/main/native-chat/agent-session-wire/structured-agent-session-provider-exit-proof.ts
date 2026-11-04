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
    // Preserve observed-exit classification/diagnostics; attach the triggering failure as cause.
    throw cleanupError instanceof AgentSessionAcquisitionRootExitObservedError
      ? new AgentSessionAcquisitionRootExitObservedError(
          new AggregateError([cause, cleanupError], cleanupError.message),
          cleanupError.deathEvidenceKind
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

/** Preserve typed refusal/exit/store verdicts after cleanup proves the child gone. */
function provenExitAcquisitionFailure(cause: unknown): unknown {
  const classified =
    cause instanceof AgentSessionAcquisitionRefusal ||
    cause instanceof AgentSessionAcquisitionRootExitObservedError ||
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    isAgentSessionPreSpawnError(cause) ||
    (cause instanceof Error && isAgentSessionWireRefusalCode(cause.message))
  return classified ? cause : new AgentSessionAcquisitionExitProvenError(cause)
}

/** Root exit or processless proof releases ownership; report descendant/bookkeeping failures after proof. */
export async function stopAgentSessionProviderRoot(
  stop: () => Promise<boolean>,
  report?: (error: Error) => void
): Promise<boolean | 'kill-delivered'> {
  try {
    return (await stop()) === true
  } catch (error) {
    if (
      error instanceof AgentSessionAcquisitionRootExitObservedError ||
      error instanceof AgentSessionAcquisitionExitProvenError
    ) {
      report?.(error)
      return error instanceof AgentSessionAcquisitionRootExitObservedError &&
        error.deathEvidenceKind === 'kill-delivered'
        ? 'kill-delivered'
        : true
    }
    if (isAgentSessionPreSpawnError(error)) {
      return true
    }
    throw error
  }
}
