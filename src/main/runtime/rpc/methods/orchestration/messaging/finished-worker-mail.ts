import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import type { DispatchContextRow } from '../../../../orchestration/db/orchestration-records'
import { dispatchReportMailbox } from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/workers/reports/worker-report-admission'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isDispatchMutationMessageType } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
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
  if (params.type === 'worker_done') {
    refuseStaleWorkerDone(db, sender, finished)
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

/** A worker_done naming an earlier Dispatch would land as plain mail while the open one stays unsettled. */
function refuseStaleWorkerDone(
  db: OrchestrationDb,
  sender: FinishedSender,
  finished: DispatchContextRow
): void {
  const open = db.getActiveDispatchForIdentity(sender.address, sender.paneKey ?? undefined)
  // A pending Dispatch's preamble has not reached the worker, so it cannot be the one meant.
  if (!open || open.id === finished.id || open.status !== 'dispatched') {
    return
  }
  throw new OrchestrationError(
    'dispatch_inactive',
    `Dispatch ${finished.id} (task ${finished.task_id}) is already ${finished.status}. Your open Dispatch is ${open.id} (task ${open.task_id}). Nothing was sent. If this report is for task ${open.task_id}, resend with your Orca CLI's \`orchestration send --from ${sender.address} --type worker_done --subject "<short status>" --body "<summary>" --task-id ${open.task_id} --dispatch-id ${open.id} --outcome <succeeded|failed>\`. If it is about task ${finished.task_id}, send it with \`--type status\` instead.`,
    { effectsApplied: false, taskId: open.task_id, dispatchId: open.id }
  )
}

/** A finished worker on a paired host cannot reach its coordinator yet; say why instead of a bare refusal.
 *  A worker since given local work is no longer that finished worker: its default mail goes to its
 *  working Dispatch, so only mail naming the finished remote Dispatch is refused. */
export function refuseFinishedRemoteWorker(
  db: OrchestrationDb,
  sender: { address: string; paneKey: string | undefined },
  to: string | undefined
): void {
  const { address, paneKey } = sender
  const attachment = paneKey ? db.findLatestRemoteAttachmentForPane(paneKey) : undefined
  if (!attachment) {
    return
  }
  if (to === `dispatch:${attachment.dispatch_id}`) {
    throw finishedRemoteUnreachable(attachment.dispatch_id)
  }
  if (!to && !db.getActiveDispatchForIdentity(address, paneKey)) {
    throw finishedRemoteUnreachable(attachment.dispatch_id)
  }
}

function finishedRemoteUnreachable(dispatchId: string): OrchestrationError {
  return new OrchestrationError(
    'run_home_unreachable',
    `Dispatch ${dispatchId} has finished, and its coordinator runs on another computer that a finished worker cannot reach yet. Nothing was sent; give the message to the user instead.`
  )
}
