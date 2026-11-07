import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration-party-identity'
import type { DispatchContextRow } from '../../../../orchestration/db/orchestration-records'
import { dispatchReportMailbox } from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/workers/reports/worker-report-admission'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isDispatchMutationMessageType } from '../../../../../../shared/rpc-contract/orchestration-params'
import type { MessageRouting } from '../routing'

/** A terminal also proves its process, so a new process in the same pane is not taken for the old worker;
 *  a session caller is already bound to its own identity. */
type FinishedSender = Pick<OrchestrationCallerIdentity, 'address' | 'paneKey' | 'orcaSessionId'> & {
  processIncarnation: () => string | undefined
}

/** The Dispatch a worker finished and is still talking about: the one its message names, or, naming none
 *  and coordinating nothing, the last one it was given. What it sends there reaches that Dispatch's coordinator. */
export function finishedWorkerDispatch(
  db: OrchestrationDb,
  sender: FinishedSender,
  routing: Pick<MessageRouting, 'run' | 'dispatchId' | 'dispatch'>,
  type: string | undefined
): DispatchContextRow | undefined {
  // A late heartbeat is already dropped quietly; it says nothing the coordinator needs.
  if (type === 'heartbeat' || (!routing.dispatchId && routing.run)) {
    return undefined
  }
  const dispatch = routing.dispatchId
    ? routing.dispatch
    : db.getLatestDispatchForTerminal(sender.address, sender.paneKey ?? undefined)
  if (
    !dispatch ||
    dispatch.status === 'pending' ||
    dispatch.status === 'dispatched' ||
    !isDispatchAssignee(dispatch, sender.address, sender.paneKey) ||
    (!sender.orcaSessionId &&
      dispatch.process_incarnation &&
      !db.isDispatchProcessCurrent({
        dispatchId: dispatch.id,
        paneKey: sender.paneKey,
        processIncarnation: sender.processIncarnation() ?? null
      })) ||
    db.getFederatedDispatch(dispatch.id)
  ) {
    return undefined
  }
  const task = type === 'worker_done' ? db.getTask(dispatch.task_id) : undefined
  return task && reportCorrectsUnobservedPrompt(dispatch, task) ? undefined : dispatch
}

/** Mail from a finished worker is ordinary mail to its coordinator, so no report or escalation reopens the Task. */
export function finishedWorkerSend<P extends { to?: string; type?: string }>(
  db: OrchestrationDb,
  sender: FinishedSender,
  routing: MessageRouting,
  params: P
):
  | { params: P; routing: MessageRouting; receipt: <T extends object>(receipt: T) => T }
  | undefined {
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
    receipt: (receipt) =>
      params.type === 'worker_done'
        ? {
            ...receipt,
            lifecycle: {
              action: 'settled',
              outcome: finished.status === 'completed' ? 'succeeded' : 'failed'
            },
            next: 'Delivered to your coordinator as a message; your finished task is unchanged. End your turn.'
          }
        : receipt
  }
}

/** A finished worker on a paired host cannot reach its coordinator yet; say why instead of a bare refusal. */
export function refuseFinishedRemoteWorker(
  db: OrchestrationDb,
  paneKey: string | undefined,
  to: string | undefined
): void {
  const attachment = paneKey ? db.findLatestRemoteAttachmentForPane(paneKey) : undefined
  if (attachment && (!to || to === `dispatch:${attachment.dispatch_id}`)) {
    throw new OrchestrationError(
      'run_home_unreachable',
      `Dispatch ${attachment.dispatch_id} has finished, and its coordinator runs on another computer that a finished worker cannot reach yet. Nothing was sent; give the message to the user instead.`
    )
  }
}
