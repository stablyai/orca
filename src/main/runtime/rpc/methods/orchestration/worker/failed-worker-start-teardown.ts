import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../orchestration-structured-worker-session'
import { resolveResidualAgentTerminal } from './failed-start-residual-terminal'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'
import type { FailedStartTerminalAdoption } from '../../../../orchestration/db/worker-terminal/failed-start-terminal-adoption'

/**
 * Undoes what a start created before it failed, and reports what `worker-release` still owns.
 *
 * A start that never reached ready leaves no settlement to release the hold later, and its session
 * was already published as a chat tab — without the discard, a failed start strands a dead chat tab
 * that the durable restore index republishes on every app launch. Both halves are best-effort by
 * construction, so neither can replace the real error.
 */
export async function tearDownFailedWorkerStart(args: {
  runtime: OrcaRuntimeService
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  dispatchId: string
  effects: unknown[]
  terminalHandle: string | undefined
  worktreeId: string | null
}): Promise<FailedStartTerminalAdoption | undefined> {
  const { runtime, structuredSession } = args
  // A structured session is torn down outright here, so it must never also be adopted as a residual
  // terminal for `worker-release` to close a second time.
  const residualAgentTerminal = structuredSession
    ? undefined
    : resolveResidualAgentTerminal({
        runtime,
        effects: args.effects as never,
        terminalHandle: args.terminalHandle,
        worktreeId: args.worktreeId
      })
  releaseStructuredWorkerSession(args.dispatchId, runtime)
  if (structuredSession) {
    await discardStructuredWorkerSession(structuredSession.identity.sessionId, runtime)
  }
  return residualAgentTerminal
}
