import type { OrcaRuntimeService } from '../../../../orca-runtime'
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
 */
export async function tearDownFailedWorkerStart(args: {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  dispatchId: string
}): Promise<void> {
  const { runtime, structuredSession } = args
  releaseStructuredWorkerSession(args.dispatchId, runtime)
  if (structuredSession) {
    await discardStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
  }
}
