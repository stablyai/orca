import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type {
  OrchestrationCallerIdentity,
  OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import type { DispatchContextRow, RunRow, TaskRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveDispatchCreator } from '../runs/dispatch-creator'

/**
 * The Run a worker-start lands in, and who may start it. The Run's coordinator starts workers in
 * it; a worker on an active Dispatch starts helpers in the Run it works for, as itself, so the
 * helpers report to it and its own mailbox never moves.
 */
export function resolveWorkerStartRun(
  runtime: OrcaRuntimeService,
  args: {
    coordinator: OrchestrationCallerIdentity | null
    from: string
    callerSession: OrchestrationSessionCaller | undefined
    runId: string | undefined
  }
): { run: RunRow; helperCreator?: DispatchContextRow } {
  const db = runtime.getOrchestrationDb()
  const coordinated = args.coordinator
    ? db.getCurrentRunForCoordinator(args.coordinator)
    : undefined
  if (coordinated) {
    if (args.runId && args.runId !== coordinated.id) {
      throw fenced(`This caller coordinates Run ${coordinated.id}, not ${args.runId}.`)
    }
    return { run: coordinated }
  }
  // Same resolution that stamps the helper's creator, so authority and reporting always agree.
  // It returns only an active, delegated Dispatch; a remote one has no row on this host.
  const creatorId = db.resolveCreatorDispatchId(
    resolveDispatchCreator(runtime, args.from, args.callerSession)
  )
  const creator = creatorId ? db.getDispatchContextById(creatorId) : undefined
  const run = creator ? db.getRun(creator.run_id) : undefined
  if (!creator || !run || run.legacy === 1) {
    throw fenced(
      'worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it.'
    )
  }
  if (args.runId && args.runId !== run.id) {
    throw fenced(
      `This worker's Dispatch ${creator.id} is in Run ${run.id}; it starts helpers only there.`
    )
  }
  return { run, helperCreator: creator }
}

/**
 * What a worker may start: a fresh helper in a terminal Orca launches for it, on this host, or a
 * retry of its own helper's latest attempt. Never the coordinator's Tasks or another party's pane.
 */
export function assertHelperStartScope(
  db: OrchestrationDb,
  creator: DispatchContextRow,
  args: { task: TaskRow | undefined; params: { on?: string; terminal?: string } }
): void {
  if (args.params.on || args.params.terminal) {
    // Why --on: remote reports land in the Run home's Run mailbox, so the helper could not report back.
    throw new OrchestrationError(
      'invalid_argument',
      'A worker starts helpers in a new agent on this host; omit --on and --terminal. No effects were applied.',
      { effectsApplied: false }
    )
  }
  if (args.task && db.getDispatchContext(args.task.id)?.creator_dispatch_id !== creator.id) {
    throw new OrchestrationError(
      'task_not_found',
      `Task ${args.task.id} was not last run by a helper of Dispatch ${creator.id}; start new helper work with --spec.`
    )
  }
}

function fenced(message: string): OrchestrationError {
  return new OrchestrationError('consumer_fenced', message)
}
