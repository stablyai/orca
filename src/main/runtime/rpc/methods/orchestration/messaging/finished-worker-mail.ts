import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { deliverQuestionAnswer } from '../../../../orchestration/question-answer-delivery'
import { continueUnreadWorkerMail } from './settled-worker-follow-through'
import type { FollowUpContext } from './worker-follow-up'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type { DispatchContextRow } from '../../../../orchestration/types'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/worker-report-admission'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { isDispatchMutationMessageType } from '../schemas'
import type { MessageRouting } from '../routing'

/** The Dispatch a worker finished and is still talking about: the one its message names, or, naming none
 *  and coordinating nothing, the last one it was given. What it sends there reaches that Dispatch's coordinator. */
export function finishedWorkerDispatch(
  db: OrchestrationDb,
  sender: Pick<OrchestrationCallerIdentity, 'address' | 'paneKey'>,
  routing: Pick<MessageRouting, 'run' | 'dispatchId' | 'dispatch'>,
  type: string | undefined
): DispatchContextRow | undefined {
  // A late heartbeat is already dropped quietly; it says nothing the coordinator needs.
  if (type === 'heartbeat' || (!routing.dispatchId && routing.run)) {
    return undefined
  }
  const dispatch = routing.dispatchId
    ? routing.dispatch
    : db.getLatestDispatchForIdentity(sender.address, sender.paneKey ?? undefined)
  if (
    !dispatch ||
    dispatch.status === 'pending' ||
    dispatch.status === 'dispatched' ||
    !wasAssignedTo(dispatch, sender) ||
    db.getFederatedDispatch(dispatch.id)
  ) {
    return undefined
  }
  const task = type === 'worker_done' ? db.getTask(dispatch.task_id) : undefined
  return task && reportCorrectsUnobservedPrompt(dispatch, task) ? undefined : dispatch
}

// The sender test of isDispatchMessageSender, for a Dispatch that has settled.
function wasAssignedTo(
  dispatch: DispatchContextRow,
  sender: Pick<OrchestrationCallerIdentity, 'address' | 'paneKey'>
): boolean {
  if (
    sender.paneKey &&
    dispatch.assignee_pane_key &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, sender.paneKey)
  ) {
    return true
  }
  return (
    sender.address === dispatch.assignee_handle && (!sender.paneKey || !dispatch.assignee_pane_key)
  )
}

/** Mail from a finished worker is ordinary mail to its coordinator, so no report or escalation reopens the Task. */
export function finishedWorkerSend<P extends { to?: string; type?: string }>(
  db: OrchestrationDb,
  sender: Pick<OrchestrationCallerIdentity, 'address' | 'paneKey'>,
  routing: MessageRouting,
  params: P
): { params: P; routing: MessageRouting; receipt: (sent: unknown) => unknown } | undefined {
  const finished = finishedWorkerDispatch(db, sender, routing, params.type)
  if (!finished) {
    return undefined
  }
  const ownDispatch = !params.to || params.to === `dispatch:${finished.id}`
  return {
    params: {
      ...params,
      type: isDispatchMutationMessageType(params.type) ? 'status' : params.type,
      to: ownDispatch ? dispatchReportMailbox(db, finished) : params.to
    },
    routing: { run: db.getRun(finished.run_id), dispatchId: undefined, dispatch: undefined },
    // Older CLIs confirm a worker_done only by a verdict; the Task's recorded one stands.
    receipt: (sent) =>
      params.type === 'worker_done' && sent && typeof sent === 'object'
        ? {
            ...sent,
            lifecycle: {
              action: 'settled',
              outcome: finished.status === 'completed' ? 'succeeded' : 'failed'
            },
            next: 'Delivered to your coordinator as a message; your finished task is unchanged. End your turn.'
          }
        : sent
  }
}

/** A worker that asked after it finished has no turn to wake; the answer continues it as the replier's send would. */
export function deliverAnswer(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  question: { message_id: string; dispatch_id: string },
  {
    from,
    ...replier
  }: Omit<FollowUpContext, 'runtime' | 'orchestrationMutation'> & { from?: string }
): void {
  const status = db.getDispatchContextById(question.dispatch_id)?.status
  deliverQuestionAnswer(
    runtime,
    question,
    status === 'pending' || status === 'dispatched'
      ? undefined
      : () =>
          continueUnreadWorkerMail(runtime, db, question.dispatch_id, {
            from: from ?? 'unknown',
            ctx: replier
          })
  )
}
