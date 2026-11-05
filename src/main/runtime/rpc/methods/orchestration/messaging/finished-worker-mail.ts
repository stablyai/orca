import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type { DispatchContextRow } from '../../../../orchestration/types'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/worker-report-admission'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isDispatchMutationMessageType } from '../schemas'
import type { MessageRouting } from '../routing'

/** A chat worker is matched by its session, and a terminal worker by its process, so neither another chat
 *  in the pane nor a new process in it is taken for the worker that finished. */
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
    (dispatch.assignee_orca_session_id
      ? dispatch.assignee_orca_session_id !== sender.orcaSessionId
      : dispatch.process_incarnation &&
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

/** Whether a Dispatch is the one that asked, or follows it up in the same Run; a later worker the pane was
 *  given is neither, so it cannot take that answer. */
export function continuesDispatch(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  askedBy: string
): boolean {
  const seen = new Set<string>()
  let at: DispatchContextRow | undefined = dispatch
  while (at && at.run_id === dispatch.run_id && !seen.has(at.id)) {
    if (at.id === askedBy) {
      return true
    }
    seen.add(at.id)
    at = at.follow_up_of_dispatch_id
      ? db.getDispatchContextById(at.follow_up_of_dispatch_id)
      : undefined
  }
  return false
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

/** Whether the pane now holds a local worker rather than the remote one: by its custody, which every worker
 *  start records, else by an active local Dispatch or one created strictly later; a tie stays remote. */
function holdsLocalWorker(
  db: OrchestrationDb,
  address: string,
  paneKey: string,
  attachment: { dispatch_id: string; created_at: string }
): boolean {
  const custodian = db.getWorkerTerminalResourceByPane(paneKey)?.owner_dispatch_id
  if (custodian) {
    return custodian !== attachment.dispatch_id && Boolean(db.getDispatchContextById(custodian))
  }
  return (
    Boolean(db.getActiveDispatchForIdentity(address, paneKey)) ||
    (db.getLatestDispatchForTerminal(address, paneKey)?.created_at ?? '') > attachment.created_at
  )
}

/** A finished worker on a paired host cannot reach its coordinator yet; say why instead of a bare refusal.
 *  A local worker the pane holds now speaks for it instead. */
export function refuseFinishedRemoteWorker(
  db: OrchestrationDb,
  sender: { address: string; paneKey: string | undefined },
  to: string | undefined
): void {
  const attachment = sender.paneKey
    ? db.findLatestRemoteAttachmentForPane(sender.paneKey)
    : undefined
  if (
    sender.paneKey &&
    attachment &&
    !holdsLocalWorker(db, sender.address, sender.paneKey, attachment) &&
    (!to || to === `dispatch:${attachment.dispatch_id}`)
  ) {
    throw new OrchestrationError(
      'run_home_unreachable',
      `Dispatch ${attachment.dispatch_id} has finished, and its coordinator runs on another computer that a finished worker cannot reach yet. Nothing was sent; give the message to the user instead.`
    )
  }
}
