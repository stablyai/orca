import type { WorkerFollowUp } from './worker-follow-up-placement'
import { createWorkerFollowUpQualification } from './worker-follow-up-admission'
import { liveDispatchCreatorEvaluation } from '../../../../orchestration/db/dispatch-depth'
import { selectExistingWorkerStartRun } from './worker-start-run-authority'
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
import { readCustodyCohort } from '../../../../orchestration/db/worker-terminal/worker-terminal-transfer'
import { createHelperStartScope } from './helper-start-scope'
import { requireOrchestrationAdmission } from '../../../../orchestration/orchestration-admission'

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
  let dispatchCreator: ReturnType<typeof resolveDispatchCreator> | undefined
  const authority = selectExistingWorkerStartRun(
    coordinated,
    args.runId,
    () => (coordinator && args.runId ? db.getCoordinatedRun(coordinator, args.runId) : undefined),
    () => {
      dispatchCreator = resolveDispatchCreator(runtime, args.from, args.callerSession)
      const creatorId = db.resolveCreatorDispatchId(dispatchCreator)
      const creator = creatorId ? db.getDispatchContextById(creatorId) : undefined
      const run = creator ? db.getRun(creator.run_id) : undefined
      return creator && run ? { creator, run } : undefined
    }
  )
  if (authority) {
    return {
      bindRun: () => ({ run: authority.run, created: false }),
      ...(authority.creator ? { helperCreator: authority.creator } : {})
    }
  }
  dispatchCreator ??= resolveDispatchCreator(runtime, args.from, args.callerSession)
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

/** Workers may start only their own helpers; caller options remain separate from private placement. */
export function assertHelperStartScope(
  db: OrchestrationDb,
  creator: DispatchContextRow,
  args: {
    task: TaskRow | undefined
    params: { on?: string; terminal?: string }
    followUp?: Pick<WorkerFollowUp, 'of' | 'addressed' | 'custodian'>
  }
): void {
  requireOrchestrationAdmission(
    createHelperStartScope(
      {
        dispatch: (id) => db.getDispatchContextById(id),
        taskDispatch: (id) => db.getDispatchContext(id),
        owned: (id) => db.getWorkerTerminalResourceByOwner(id),
        cohort: (incarnation, host) => readCustodyCohort(db, incarnation, host)
      },
      creator
    )(args)
  )
}

function fenced(message: string): OrchestrationError {
  return new OrchestrationError('consumer_fenced', message)
}

export function qualifyLiveWorkerFollowUp(
  runtime: OrcaRuntimeService,
  coordinator: OrchestrationCallerIdentity | null,
  from: string,
  session: OrchestrationSessionCaller | undefined,
  runId: string,
  followUp: Parameters<ReturnType<typeof createWorkerFollowUpQualification>>[1]
) {
  const db = runtime.getOrchestrationDb()
  return requireOrchestrationAdmission(
    createWorkerFollowUpQualification({
      coordinated: () => (coordinator ? db.getCurrentRunForCoordinator(coordinator) : undefined),
      named: (id) => (coordinator ? db.getCoordinatedRun(coordinator, id) : undefined),
      run: (id) => db.getRun(id),
      dispatch: (id) => db.getDispatchContextById(id),
      taskDispatch: (id) => db.getDispatchContext(id),
      owned: (id) => db.getWorkerTerminalResourceByOwner(id),
      cohort: (incarnation, host) => readCustodyCohort(db, incarnation, host),
      caller: () =>
        liveDispatchCreatorEvaluation(db, resolveDispatchCreator(runtime, from, session)),
      maxDepth: () => runtime.getNestedWorkerMaxDepth()
    })(runId, followUp)
  )
}
