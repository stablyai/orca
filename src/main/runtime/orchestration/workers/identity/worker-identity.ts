import { buildOrchestrationTaskDisplayMetadata } from '../../../../../shared/orchestration/orchestration-task-display'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { TaskRow } from '../../db/orchestration-records'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { getRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { senderDispatchLaunch } from '../../mailbox/senders/sender-dispatch-launch'

/** Who a worker is, by its Dispatch: its task, its agent, and the paired server it runs on. */
export type WorkerIdentity = Readonly<{
  dispatchId: string
  taskId: string
  title: string | null
  agent: AgentType | null
  /** The paired server's name; null for a worker on this Orca. */
  hostLabel: string | null
}>

/** The Task's title, else its display name. */
export function workerTaskTitle(
  task: Pick<TaskRow, 'spec' | 'task_title' | 'display_name'> | undefined
): string | null {
  if (!task) {
    return null
  }
  const display = buildOrchestrationTaskDisplayMetadata({
    spec: task.spec,
    taskTitle: task.task_title,
    displayName: task.display_name
  })
  return display.taskTitle || display.displayName || null
}

/** Local, server-owned and legacy relayed Dispatches all answer here; null when this Orca has none. */
export function workerIdentity(db: OrchestrationDb, dispatchId: string): WorkerIdentity | null {
  const remote = getRemoteDispatch(db, dispatchId)
  if (remote) {
    return {
      dispatchId,
      taskId: remote.task_id,
      title: workerTaskTitle(db.getTask(remote.task_id)),
      agent: remote.agent,
      hostLabel: getRemoteRunLink(db, remote.conversation_id)?.server_name ?? null
    }
  }
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return null
  }
  return {
    dispatchId,
    taskId: dispatch.task_id,
    title: workerTaskTitle(db.getTask(dispatch.task_id)),
    agent: senderDispatchLaunch(db)(dispatch),
    hostLabel: db.getFederatedDispatch(dispatchId)?.environment_name ?? null
  }
}

/** A worker's name once its chat or terminal is gone: its task ("Fix login"); every surface naming it
 *  shows the agent's icon, so the agent word stands in only when the task has no title. */
export function workerIdentityName(
  identity: Pick<WorkerIdentity, 'title' | 'agent'>
): string | null {
  return (
    identity.title ||
    (identity.agent && identity.agent !== 'unknown' ? formatAgentTypeLabel(identity.agent) : null)
  )
}
