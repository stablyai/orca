import { appendWorkflowEvent } from '../../shared/workflow/workflow-run-state'
import { WorkflowRequestError } from './workflow-request-error'
import type { WorkflowRunSession } from './workflow-run-session'

/** Inside a session turn: deliver or drop a held message, unblocking its task once nothing else is held. */
export function releaseHeldWorkflowMessage(
  session: WorkflowRunSession,
  messageId: string,
  decision: 'deliver' | 'drop'
): void {
  const message = session.run.messages.find((candidate) => candidate.id === messageId)
  if (!message || message.deliveryState !== 'held') {
    throw new WorkflowRequestError('message_not_held', 'That message is not waiting for approval.')
  }
  message.deliveryState = decision === 'deliver' ? 'delivered' : 'dropped-by-approval'
  message.releasedAt = session.at()
  const kind = decision === 'deliver' ? 'message-delivered' : 'message-rejected'
  appendWorkflowEvent(
    session.run,
    kind,
    session.at(),
    `Held message ${decision === 'deliver' ? 'approved' : 'dropped'} by the user.`,
    { correlationId: message.correlationId }
  )
  const task = message.taskKey ? session.run.tasks[message.taskKey] : undefined
  const stillHeld = session.run.messages.some(
    (candidate) => candidate.taskKey === task?.key && candidate.deliveryState === 'held'
  )
  if (task?.status === 'blocked' && !stillHeld) {
    task.status = 'ready'
  }
}
