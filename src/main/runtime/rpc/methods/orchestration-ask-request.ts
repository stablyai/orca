import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { QuestionRow, RunRow } from '../../orchestration/types'

export type AskRequestTarget =
  | { kind: 'resume'; question: QuestionRow }
  | { kind: 'create'; run: RunRow }

// Why: an explicit --run or --to that disagrees with the Dispatch's own Run must fail rather than
// be ignored, or the caller waits on a Question filed under a Run it did not name.
function assertExplicitTargetMatchesRun(args: {
  dispatchId: string
  runId: string
  coordinatorHandle?: string | null
  declaredRun?: string
  to?: string
}): void {
  if (args.declaredRun && args.declaredRun !== args.runId) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `Dispatch ${args.dispatchId} belongs to Run ${args.runId}, not ${args.declaredRun}.`
    )
  }
  if (args.to && args.to !== `run:${args.runId}` && args.to !== args.coordinatorHandle) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `ask from Dispatch ${args.dispatchId} must target its owning Run ${args.runId}.`
    )
  }
}

/**
 * Resolves what an ask refers to, reading only. Kept separate from the answerability guard so
 * the caller can validate the request first: a bad resume id or a mismatched Run has its own
 * error code, and a guard that ran earlier would shadow it.
 */
export function resolveAskRequestTarget(args: {
  db: OrchestrationDb
  dispatch: { id: string; run_id: string }
  resume?: string
  run?: string
  to?: string
}): AskRequestTarget {
  const { db, dispatch } = args
  if (args.resume) {
    const question = db.getQuestion(args.resume)
    if (!question || question.dispatch_id !== dispatch.id) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${args.resume} does not belong to this active Dispatch.`
      )
    }
    // Why: resume recovers an already-committed Question, including one filed under a legacy Run,
    // so the Run is read for its coordinator handle only — an unresolvable Run must not turn
    // resume itself into an error the way it does for a fresh ask.
    assertExplicitTargetMatchesRun({
      dispatchId: dispatch.id,
      runId: dispatch.run_id,
      coordinatorHandle: db.getRun(dispatch.run_id)?.coordinator_handle,
      declaredRun: args.run,
      to: args.to
    })
    return { kind: 'resume', question }
  }

  const run = db.getRun(dispatch.run_id)
  if (!run || run.legacy === 1) {
    throw new OrchestrationError('run_not_found', `Run ${dispatch.run_id} was not found.`)
  }
  assertExplicitTargetMatchesRun({
    dispatchId: dispatch.id,
    runId: run.id,
    coordinatorHandle: run.coordinator_handle,
    declaredRun: args.run,
    to: args.to
  })
  return { kind: 'create', run }
}
