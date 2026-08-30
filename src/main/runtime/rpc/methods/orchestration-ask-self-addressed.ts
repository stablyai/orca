import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'

// Why: a Question sits in its Run's home inbox, and orchestration.reply only accepts an answer
// from the pane currently bound as that Run's coordinator. When the asker is that pane, the only
// process allowed to answer is the one blocked on the answer, so the wait can never end.
export function assertAskIsAnswerable(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  callerPaneKey?: string
}): void {
  if (!args.callerPaneKey) {
    return
  }
  const boundRun = args.db.getCurrentRunForPane(args.callerPaneKey)
  if (boundRun?.id !== args.runId) {
    return
  }
  throw new OrchestrationError(
    'ask_self_addressed',
    `ask from Dispatch ${args.dispatchId} would deliver the Question to the home inbox of Run ${args.runId}, and this terminal is that Run's bound coordinator, so no other reader could answer it. Use "orchestration send --to run:${args.runId}" for a non-blocking message, or ask again once another terminal holds the Run.`,
    { effectsApplied: false }
  )
}
