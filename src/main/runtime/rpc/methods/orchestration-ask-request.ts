import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { QuestionRow, RunRow } from '../../orchestration/types'

export type AskRequestTarget =
  | { kind: 'resume'; question: QuestionRow }
  | { kind: 'create'; run: RunRow }

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
    return { kind: 'resume', question }
  }

  const run = db.getRun(dispatch.run_id)
  if (!run || run.legacy === 1) {
    throw new OrchestrationError('run_not_found', `Run ${dispatch.run_id} was not found.`)
  }
  if (args.run && args.run !== run.id) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `Dispatch ${dispatch.id} belongs to Run ${run.id}, not ${args.run}.`
    )
  }
  if (args.to && args.to !== `run:${run.id}` && args.to !== run.coordinator_handle) {
    throw new OrchestrationError(
      'dispatch_run_mismatch',
      `ask from Dispatch ${dispatch.id} must target its owning Run ${run.id}.`
    )
  }
  return { kind: 'create', run }
}
