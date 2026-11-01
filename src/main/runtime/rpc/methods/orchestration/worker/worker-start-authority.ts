import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type {
  OrchestrationCallerIdentity,
  OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import type { DispatchContextRow, RunRow, TaskRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { createBoundRun } from '../runs/runs'
import { ROOT_DISPATCH_DEPTH } from '../../../../../../shared/nested-worker-depth'
import { previousCustodianLookup } from '../../../../orchestration/db/worker-terminal/worker-terminal-transfer'
import type { WorkerFollowUp } from './worker-follow-up-placement'

export type WorkerStartRunBinding = { run: RunRow; created: boolean }

/** Coordinators start workers in their Run, creating one when none is bound; active workers start helpers as themselves so reports return to their Dispatch without moving its mailbox. A new Run is created and bound only when `bindRun` is first called, so a start refused before it leaves no Run behind. */
export function resolveWorkerStartRun(
  runtime: OrcaRuntimeService,
  args: {
    coordinator: OrchestrationCallerIdentity | null
    from: string
    callerSession: OrchestrationSessionCaller | undefined
    runId: string | undefined
    /** Objective for a Run this start may create; absent when it names an existing Task. */
    objective: string | undefined
    /** Task ids the new Task depends on or sits under. */
    taskReferences: readonly string[]
  }
): { bindRun: () => WorkerStartRunBinding; helperCreator?: DispatchContextRow } {
  const db = runtime.getOrchestrationDb()
  const coordinator = args.coordinator
  const coordinated = coordinator ? db.getCurrentRunForCoordinator(coordinator) : undefined
  if (coordinator && coordinated) {
    const run = args.runId ? db.getCoordinatedRun(coordinator, args.runId) : coordinated
    if (!run) {
      throw fenced(`This caller coordinates Run ${coordinated.id}, not ${args.runId}.`)
    }
    return { bindRun: () => ({ run, created: false }) }
  }
  // Use the same active delegated Dispatch for authority and creator/reporting identity; remote Dispatches have no local row.
  const dispatchCreator = resolveDispatchCreator(runtime, args.from, args.callerSession)
  const creatorId = db.resolveCreatorDispatchId(dispatchCreator)
  const creator = creatorId ? db.getDispatchContextById(creatorId) : undefined
  const run = creator ? db.getRun(creator.run_id) : undefined
  if (creator && run && run.legacy !== 1) {
    if (args.runId && args.runId !== run.id) {
      throw fenced(
        `This worker's Dispatch ${creator.id} is in Run ${run.id}; it starts helpers only there.`
      )
    }
    return { bindRun: () => ({ run, created: false }), helperCreator: creator }
  }
  // Only a root caller gets a new Run, so a worker can never reset its depth this way.
  if (
    args.coordinator &&
    args.objective &&
    !args.runId &&
    db.resolveCreatorDepth(dispatchCreator) === ROOT_DISPATCH_DEPTH
  ) {
    if (args.taskReferences.length > 0) {
      // No Run is bound yet, so no existing Task can belong to the one this start would create.
      throw new OrchestrationError(
        'task_not_found',
        `Task ${args.taskReferences[0]} is not in a Run this caller coordinates. No effects were applied.`,
        { effectsApplied: false }
      )
    }
    const { coordinator: caller, objective } = args
    let binding: WorkerStartRunBinding | undefined
    // Resolved at bind time with no await, so a parallel first start that bound a Run during preflight is reused.
    const bindCurrentOrNew = (): WorkerStartRunBinding => {
      const current = db.getCurrentRunForCoordinator(caller)
      return current
        ? { run: current, created: false }
        : { run: createBoundRun(runtime, caller, args.from, objective), created: true }
    }
    return { bindRun: () => (binding ??= bindCurrentOrNew()) }
  }
  throw fenced(
    'worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it.'
  )
}

/** Workers may launch fresh local helpers or retry their own helper's latest Attempt, never coordinator Tasks or another party's pane. */
export function assertHelperStartScope(
  db: OrchestrationDb,
  creator: DispatchContextRow,
  args: {
    task: TaskRow | undefined
    params: { on?: string; terminal?: string }
    followUp?: Pick<WorkerFollowUp, 'of' | 'addressed' | 'custodian'>
  }
): void {
  if (args.params.on || args.params.terminal) {
    // Remote reports reach the Run home mailbox, so a helper there could not report to its creator.
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
  if (args.followUp) {
    const { of, addressed, custodian } = args.followUp
    const holder = custodian
      ? db.getDispatchContextById(custodian)
      : creationRoot(db, of, creator.run_id)
    const owner = holder?.run_id === creator.run_id ? holder.creator_dispatch_id : null
    if (!owner || !continuesDispatch(db, creator, owner)) {
      const target =
        of === addressed
          ? `Dispatch ${addressed}`
          : `Dispatch ${addressed}'s latest work, Dispatch ${of},`
      throw new OrchestrationError(
        'task_not_found',
        `${target} is not a helper of Dispatch ${creator.id}, so only the coordinator or the worker that started it can give it more work; to hand this to a helper, start new helper work with worker-start --spec. No effects were applied.`,
        { effectsApplied: false }
      )
    }
  }
}

/** With no agent ever placed in the lineage, the helper is still its requester's: the first Dispatch of its follow-up chain. */
function creationRoot(
  db: OrchestrationDb,
  latestId: string,
  runId: string
): DispatchContextRow | undefined {
  const seen = new Set<string>()
  let row = db.getDispatchContextById(latestId)
  while (row && row.run_id === runId && !seen.has(row.id)) {
    if (!row.follow_up_of_dispatch_id) {
      return row
    }
    seen.add(row.id)
    row = db.getDispatchContextById(row.follow_up_of_dispatch_id)
  }
  return undefined
}

/** Whether `ancestorId` is `from` or an earlier Dispatch of the same worker in its Run: one it continued with a
 *  follow-up, or whose exact process it took over in saved custody. Each hop is read, so another Run in between ends
 *  the walk. */
function continuesDispatch(
  db: OrchestrationDb,
  from: DispatchContextRow,
  ancestorId: string
): boolean {
  const seen = new Set<string>()
  const previousCustodian = previousCustodianLookup(db)
  const pending: (DispatchContextRow | undefined)[] = [from]
  while (pending.length > 0) {
    const row = pending.pop()
    if (!row || row.run_id !== from.run_id || seen.has(row.id)) {
      continue
    }
    if (row.id === ancestorId) {
      return true
    }
    seen.add(row.id)
    for (const id of new Set([row.follow_up_of_dispatch_id, previousCustodian(row)])) {
      if (id && !seen.has(id)) {
        pending.push(db.getDispatchContextById(id))
      }
    }
  }
  return false
}

function fenced(message: string): OrchestrationError {
  return new OrchestrationError('consumer_fenced', message)
}
