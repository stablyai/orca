import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type {
  DispatchContextRow,
  RemoteDispatchAttachmentRow
} from '../../../../orchestration/types'
import { takesFinishedWorkerMail } from '../../../../orchestration/finished-worker-relay'
import { isRunHomeListening } from '../../../../orchestration/run-home-listening'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/worker-report-admission'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isDispatchMutationMessageType } from '../schemas'
import { FINISHED_WORKER_DONE_NEXT } from '../receipt-next'
import { rejectFederatedExplicitTarget, type MessageRouting } from '../routing'

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
            next: FINISHED_WORKER_DONE_NEXT
          }
        : receipt
  }
}

/** The remote Dispatch a paired-host pane speaks for: its live one, which reaches only its Run home, or the one
 *  it finished, when the message is for that coordinator. */
export function remoteSenderAttachment(
  db: OrchestrationDb,
  paneKey: string,
  params: { to?: string; run?: string; type?: string },
  processIncarnation: () => string | undefined
): { attachment: RemoteDispatchAttachmentRow; finished: boolean } | undefined {
  const live = db.findActiveRemoteAttachmentForPane(paneKey)
  if (live) {
    rejectFederatedExplicitTarget(params, live.home_run_id)
    return { attachment: live, finished: false }
  }
  const finished = finishedRemoteAttachment(db, paneKey, params, processIncarnation)
  return finished && { attachment: finished, finished: true }
}

/** The settled remote Dispatch a paired-host worker is still talking about, when its message is for its
 *  coordinator. A Run home too old to pull it, or no longer listening, gets a refusal that says why. */
function finishedRemoteAttachment(
  db: OrchestrationDb,
  paneKey: string,
  params: { to?: string; type?: string },
  processIncarnation: () => string | undefined
): RemoteDispatchAttachmentRow | undefined {
  const attachment = db.findLatestRemoteAttachmentForPane(paneKey)
  if (
    !attachment ||
    params.type === 'heartbeat' ||
    (params.to && params.to !== `dispatch:${attachment.dispatch_id}`) ||
    // A new process in the same pane is not the worker that finished.
    (attachment.process_incarnation &&
      !db.isRemoteAttachmentProcessCurrent({
        dispatchId: attachment.dispatch_id,
        paneKey,
        processIncarnation: processIncarnation() ?? null
      }))
  ) {
    return undefined
  }
  if (
    !takesFinishedWorkerMail(attachment) ||
    !db.isFinishedRemoteWorkerHeard(attachment.dispatch_id) ||
    !isRunHomeListening(db, attachment.home_peer_fingerprint)
  ) {
    throw new OrchestrationError(
      'run_home_unreachable',
      `Dispatch ${attachment.dispatch_id} has finished, and its coordinator runs on another computer that is no longer taking mail from this worker. Nothing was sent; give the message to the user instead.`
    )
  }
  return attachment
}
