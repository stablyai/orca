import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../orchestration-structured-worker-session'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

/** Best-effort structured cleanup hides durable/live chat tabs without replacing the original error.
 * Keep created PTYs: their custody rows let the coordinator decide when worker-release should close them. */
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
