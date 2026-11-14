import { closeStructuredAgentSessionChild } from '../../../../../../agent-session/structured-agent-session-close'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../../structured-workers/orchestration-structured-worker-session'
import type { createStructuredWorkerSessionForWorktree } from '../placement/worker-placement-topology'

/** Keep refused tasks reachable with their worker custody until retry or release; other partial starts retire their surface. */
export async function tearDownFailedWorkerStart(args: {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  dispatchId: string
  error: unknown
}): Promise<void> {
  const { runtime, structuredSession } = args
  if (structuredSession) {
    if (
      args.error instanceof OrchestrationError &&
      args.error.code === 'dispatch_preamble_undelivered'
    ) {
      const stopped = await closeStructuredAgentSessionChild(structuredSession.identity.sessionId, {
        runtime,
        surface: null
      })
      if (!stopped.stopped) {
        console.warn(
          '[orchestration] failed worker is still attached',
          args.dispatchId,
          stopped.reason
        )
      }
      return
    }
    releaseStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
    await discardStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
  }
}
