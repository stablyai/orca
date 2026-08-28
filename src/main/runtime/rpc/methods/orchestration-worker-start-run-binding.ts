import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  resolveOrchestrationCaller,
  type OrchestrationCallerParams
} from './orchestration-run-scope'

/** Fences worker-start to the Run the declared coordinator pane is actually bound to. */
export function resolveWorkerStartRunBinding(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  input: { from: string; run?: string; task: string }
  callerEvidence?: OrchestrationCallerParams['callerEvidence']
}) {
  const { runtime, db, input } = args
  // Why: worker-start was the only Run-scoped verb that skipped this, so a
  // declared --from could name someone else's pane and inherit their depth.
  const coordinatorPane = resolveOrchestrationCaller(runtime, {
    callerTerminalHandle: input.from,
    callerEvidence: args.callerEvidence
  })
  const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
  if (!run || (input.run && input.run !== run.id)) {
    throw new OrchestrationError(
      'consumer_fenced',
      'worker-start requires the coordinator terminal currently bound to the Task Run.'
    )
  }
  const task = db.getTask(input.task)
  if (!task || task.run_id !== run.id) {
    throw new OrchestrationError(
      'task_not_found',
      `Task ${input.task} was not found in Run ${run.id}.`
    )
  }
  return { run, task }
}
