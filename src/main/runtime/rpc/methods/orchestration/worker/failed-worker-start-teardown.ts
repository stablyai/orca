import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../orchestration-structured-worker-session'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

/**
 * Undoes what a start created before it failed.
 *
 * A start that never reached ready leaves no settlement to release the hold later, and its session
 * was already published as a chat tab — without the discard, a failed start strands a dead chat tab
 * that the durable restore index republishes on every app launch. Both halves are best-effort by
 * construction, so neither can replace the real error.
 *
 * A created PTY terminal is deliberately NOT torn down: its custody row was written at creation, so
 * `worker-release` on the failed Dispatch owns that cleanup and the coordinator decides when.
 *
 * A NON-DEFINITIVE failure undoes NOTHING, hold included. The dispatch's hold is what keeps the
 * child alive until the worker settles, and dropping it here arms the 15s release clock, whose only
 * remaining guard is an active-turn projection: a delayed acknowledgement that has not yet put a
 * running turn in the journal reads as "no turn", and the clock evicts the session before it is
 * ever acknowledged. Retaining until an explicit settlement (`worker-stop`, `worker-release`,
 * `worker-abandon`, each of which releases) is the only rule that does not depend on that race.
 */
export async function tearDownFailedWorkerStart(args: {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  dispatchId: string
  error?: unknown
}): Promise<void> {
  const { runtime, structuredSession } = args
  if (!isDefinitiveWorkerStartFailure(args.error)) {
    return
  }
  releaseStructuredWorkerSession(args.dispatchId, runtime)
  if (structuredSession) {
    await discardStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
  }
}

/**
 * Whether the failure proves the worker is not running.
 *
 * `operation_unknown` proves the opposite: the preamble was submitted and MAY be mid-turn, which is
 * why its receipt sends the coordinator to look. Tearing down there destroys the thing to look at
 * and turns a recoverable start into a dead session — the structured route's whole failure mode.
 */
function isDefinitiveWorkerStartFailure(error: unknown): boolean {
  return !(error instanceof OrchestrationError && error.code === 'operation_unknown')
}
