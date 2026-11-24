import type {
  AgentPublicIdentity,
  WorkerTabLineage,
  WorkerTabStamp
} from '../../../../../shared/orchestration/workers/worker-tab-stamp'
import type { DispatchContextRow, RunRow, TaskRow } from '../../db/orchestration-records'
import { crewTaskDisplay } from '../../crew/crew-rules'
import type { OrchestrationDb } from '../../db/orchestration-db'

type RunCoordinator = Pick<RunRow, 'coordinator_pane_key' | 'coordinator_orca_session_id'>
type CreatorDispatch = Pick<DispatchContextRow, 'assignee_pane_key' | 'assignee_orca_session_id'>

/** The Run's durable coordinator: its pane, else its chat's session lineage root; never the immediate parent. */
export function runCoordinatorIdentity(run: RunCoordinator): AgentPublicIdentity | null {
  if (run.coordinator_pane_key) {
    return { kind: 'pane', paneKey: run.coordinator_pane_key }
  }
  if (run.coordinator_orca_session_id) {
    return { kind: 'session', lineageRootSessionId: run.coordinator_orca_session_id }
  }
  return null
}

function creatorIdentity(creator: CreatorDispatch | undefined): AgentPublicIdentity | null {
  if (creator?.assignee_pane_key) {
    return { kind: 'pane', paneKey: creator.assignee_pane_key }
  }
  if (creator?.assignee_orca_session_id) {
    return { kind: 'session', lineageRootSessionId: creator.assignee_orca_session_id }
  }
  return null
}

/** Lineage for one Dispatch: creator-first parent, else the Run coordinator. Null when the Run has no coordinator identity. */
export function workerTabLineageAtLaunch(args: {
  run: Pick<RunRow, 'id'> & RunCoordinator
  task: Pick<TaskRow, 'id' | 'spec' | 'task_title' | 'display_name'>
  dispatchId: string
  creator?: CreatorDispatch
}): WorkerTabLineage | null {
  const coordinator = runCoordinatorIdentity(args.run)
  if (!coordinator) {
    return null
  }
  const taskTitle = crewTaskDisplay(args.task).taskTitle
  return {
    runId: args.run.id,
    dispatchId: args.dispatchId,
    taskId: args.task.id,
    ...(taskTitle ? { taskTitle } : {}),
    parent: creatorIdentity(args.creator) ?? coordinator,
    coordinator
  }
}

/** The stamp for a surface Orca creates for a worker; `createTerminal` fills the terminal leaf. */
export function workerTabStampAtLaunch(
  args: Parameters<typeof workerTabLineageAtLaunch>[0]
): WorkerTabStamp | undefined {
  const origin = workerTabLineageAtLaunch(args)
  return origin ? { origin } : undefined
}

/** The stamp for the surface a Dispatch's start creates, read from durable Dispatch, Run and Task rows. */
export function workerTabStampForDispatch(
  db: OrchestrationDb,
  dispatchId: string,
  takeoverTerminal?: string
): WorkerTabStamp | undefined {
  if (takeoverTerminal) {
    return undefined
  }
  const dispatch = db.getDispatchContextById(dispatchId)
  const run = dispatch ? db.getRun(dispatch.run_id) : undefined
  const task = dispatch ? db.getTask(dispatch.task_id) : undefined
  if (!dispatch || !run || !task) {
    return undefined
  }
  const creator = dispatch.creator_dispatch_id
    ? (db.getDispatchContextById(dispatch.creator_dispatch_id) ?? undefined)
    : undefined
  return workerTabStampAtLaunch({ run, task, dispatchId, ...(creator ? { creator } : {}) })
}
