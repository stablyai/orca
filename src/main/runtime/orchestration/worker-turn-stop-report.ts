import { createHash } from 'node:crypto'
import type { OrchestrationDb } from './db'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import type { DispatchContextRow, RemoteDispatchAttachmentRow } from './types'
import { escalateWorkerFailure } from './worker-failure-escalation'
import { replaceDispatchCapabilities } from './worker-terminal-redaction'

// One screenful: enough to show the agent's last words or error banner without flooding the inbox.
const LAST_OUTPUT_MAX_CHARS = 2_000

export type WorkerTurnStopReason = 'finished' | 'errored' | 'needs-input' | 'exited'

export type WorkerTurnStop = {
  /** The worker's own mailbox identity: terminal handle, chat address or structured worker handle. */
  from: string
  /** Identifies this stop; a later turn's stop has a new one, so each stop is reported once. */
  stopKey: string
  reason: WorkerTurnStopReason
  lastOutput: string | undefined
  /** Why the process ended, for an `exited` stop. */
  exitCause?: string
}

export type WorkerTurnStopDispatch =
  | { kind: 'local'; dispatch: DispatchContextRow }
  | { kind: 'remote'; attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'task_id'> }

export type WorkerTurnStopReportDeps = {
  getDb: () => OrchestrationDb | null
  /** `check --wait` holds a `dispatch:<id>` waiter: a deliberate wait. */
  isWaitingForMail: (mailbox: string) => boolean
  notify: (handle: string, messageType: string) => void
}

export function workerTurnStopDispatchId(target: WorkerTurnStopDispatch): string {
  return target.kind === 'local' ? target.dispatch.id : target.attachment.dispatch_id
}

const SUBJECTS: Record<WorkerTurnStopReason, string> = {
  finished: 'Worker stopped without reporting',
  errored: 'Worker stopped on an error without reporting',
  'needs-input': 'Worker is waiting on a prompt',
  exited: 'Worker exited without reporting'
}

function describeStop(stop: WorkerTurnStop, task: string, dispatchId: string): string {
  const what =
    stop.reason === 'needs-input'
      ? `Worker ${stop.from} is stopped at a prompt that needs a person (approval or a question) while running task ${task}.`
      : stop.reason === 'exited'
        ? `Worker ${stop.from} exited (${stop.exitCause ?? 'process ended'}) without sending worker_done for task ${task}.`
        : `Worker ${stop.from} ended its turn ${stop.reason === 'errored' ? 'on an error ' : ''}without sending worker_done for task ${task}.`
  // Agent prose can echo its injected capability; mail must never carry it.
  const output = stop.lastOutput && replaceDispatchCapabilities(stop.lastOutput).value.trim()
  return [
    what,
    stop.reason === 'exited'
      ? 'The Dispatch is still open. Stop the worker, then retry it or tell the user.'
      : // The reader runs its own CLI build, so name the subcommand, never an executable.
        `The Dispatch is still open. Answer it with your Orca CLI's \`orchestration send --to dispatch:${dispatchId} --subject "<topic>" --body "<guidance>"\`, retry it, or stop the worker.`,
    ...(output
      ? [
          'Last output:',
          output.length > LAST_OUTPUT_MAX_CHARS
            ? `…${output.slice(-LAST_OUTPUT_MAX_CHARS)}`
            : output
        ]
      : []),
    `Full output: orchestration worker-read --dispatch ${dispatchId}`
  ].join('\n')
}

/** Tell the coordinator once that a worker is at rest with its Dispatch unsettled; never settles it. */
export function reportWorkerTurnStop(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  stop: WorkerTurnStop,
  deps: WorkerTurnStopReportDeps
): void {
  const dispatchId = workerTurnStopDispatchId(target)
  // Waiting on mail, or a clean finish resting on its own question or helpers, is deliberate; an exit never is.
  if (
    stop.reason !== 'exited' &&
    (deps.isWaitingForMail(`dispatch:${dispatchId}`) ||
      (stop.reason === 'finished' &&
        (db.awaitsAnswerToLatestQuestion(dispatchId) ||
          (target.kind === 'local' && db.hasOpenHelperDispatch(dispatchId)))))
  ) {
    return
  }
  const id = `msg_stop_${createHash('sha256')
    .update(JSON.stringify([dispatchId, stop.stopKey]))
    .digest('hex')
    .slice(0, 24)}`
  const payload = { dispatchId, handle: stop.from, stopReason: stop.reason }
  if (target.kind === 'local') {
    const { dispatch } = target
    escalateWorkerFailure(
      db,
      dispatch,
      {
        id,
        from: stop.from,
        mailbox: () => dispatchReportMailbox(db, dispatch),
        describe: (task) => ({
          subject: SUBJECTS[stop.reason],
          body: describeStop(stop, task, dispatch.id)
        }),
        payload: { taskId: dispatch.task_id, ...payload }
      },
      deps.notify
    )
    return
  }
  // The Run home imports relayed worker mail into the coordinator's Run and wakes it.
  const { attachment } = target
  // A worker_done the home has not acknowledged yet is still a report.
  if (db.hasPendingFederatedWorkerReport(dispatchId)) {
    return
  }
  // The stable message id makes a repeated report of the same stop a no-op on both sides.
  try {
    db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'escalation',
      messageId: id,
      payload: JSON.stringify({
        from: stop.from,
        subject: SUBJECTS[stop.reason],
        body: describeStop(stop, attachment.task_id, dispatchId),
        type: 'escalation',
        priority: 'high',
        threadId: null,
        // Relayed payloads travel as strings, as a worker's own `send` relays them.
        payload: JSON.stringify({ taskId: attachment.task_id, ...payload })
      })
    })
  } catch (error) {
    console.warn('[orchestration] failed to relay a worker stop report', dispatchId, error)
  }
}
