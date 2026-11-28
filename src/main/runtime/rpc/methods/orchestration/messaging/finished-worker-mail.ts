import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import type { DispatchContextRow } from '../../../../orchestration/db/orchestration-records'
import { dispatchReportMailbox } from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { reportCorrectsUnobservedPrompt } from '../../../../orchestration/workers/reports/worker-report-admission'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isDispatchMutationMessageType } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import type { MessageRouting } from '../routing'
import { parseRemoteWorkerPayload } from './message-payload'
import { assertReportPathCaptured } from './send-params-checks'

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

/** Binds local report files to their worker. A finished worker's mail reaches its coordinator without reopening its Task. */
export function prepareLocalWorkerSend<P extends { to?: string; type?: string; payload?: string }>(
  db: OrchestrationDb,
  sender: FinishedSender,
  routing: MessageRouting,
  params: P
):
  | { params: P; routing: MessageRouting; receipt?: <T extends object>(receipt: T) => T }
  | undefined {
  const finished = finishedWorkerDispatch(db, sender, routing, params.type)
  if (finished && params.type === 'worker_done') {
    refuseStaleWorkerDone(db, sender, finished)
  }
  const payload =
    params.type === 'worker_done'
      ? bindLocalWorkerReport(db, sender, params.payload, routing.dispatch, finished)
      : params.payload
  if (!finished) {
    return payload === params.payload ? undefined : { params: { ...params, payload }, routing }
  }
  const ownDispatch = !params.to || params.to === `dispatch:${finished.id}`
  return {
    params: {
      ...params,
      payload,
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

function bindLocalWorkerReport(
  db: OrchestrationDb,
  sender: FinishedSender,
  payload: string | undefined,
  dispatch: DispatchContextRow | undefined,
  finished: DispatchContextRow | undefined
): string | undefined {
  let report: Record<string, unknown>
  try {
    report = parseRemoteWorkerPayload(payload)
  } catch {
    // Leave malformed payloads to the existing message validation.
    return payload
  }
  // Finished reports become status mail before the worker_done validation runs.
  if (finished) {
    assertReportPathCaptured(report)
  }
  if (typeof report.reportContentBase64 !== 'string') {
    return payload
  }
  // Finished worker mail has already checked the sender and any newer Dispatch.
  const active =
    finished ?? db.getActiveDispatchForIdentity(sender.address, sender.paneKey ?? undefined)
  const target = finished ?? dispatch
  if (
    !target ||
    !isDispatchAssignee(target, sender.address, sender.paneKey) ||
    (active && active.id !== target.id) ||
    (report.dispatchId !== undefined && report.dispatchId !== target.id)
  ) {
    throw new OrchestrationError(
      'dispatch_inactive',
      'No matching Dispatch was found for this worker report. Nothing was sent.'
    )
  }
  return report.dispatchId === undefined
    ? JSON.stringify({ ...report, dispatchId: target.id })
    : payload
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
