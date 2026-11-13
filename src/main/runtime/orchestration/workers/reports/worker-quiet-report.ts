import type { OrchestrationDb } from '../../db/orchestration-db'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import { escalateWorkerFailure } from './worker-failure-escalation'
import { stopReportId, type WorkerTurnStopDispatch } from '../turn-stops/worker-turn-stop-report'
import type { QuietNotice, WorkerQuietObservation } from './worker-quiet-sweep'

export function reportWorkerQuiet(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  worker: WorkerQuietObservation & { from: string; agent: string },
  notice: QuietNotice,
  notify: (handle: string, type: string) => void
): boolean {
  const id = stopReportId(worker.dispatchId, `quiet:${worker.turnStartedAt}:${notice.ordinal}`)
  const minutes = Math.floor(
    (notice.observedAt -
      (worker.tool?.startedAt ??
        worker.lastProducerEventAt ??
        worker.workingSince ??
        worker.turnStartedAt)) /
      60_000
  )
  const detail = !(worker.progressObservable ?? worker.lastProducerEventAt !== undefined)
    ? `Orca can't see ${worker.agent}'s progress; it has shown working for ${minutes} min.`
    : worker.tool
      ? `${worker.agent} has been running ${worker.tool.name} for ${minutes} min.`
      : `${worker.agent} has shown no progress for ${minutes} min.`
  const subject = 'Worker is still running quietly'
  const body = `Worker ${worker.from} (${worker.agent}) is still running. ${detail} This may be normal. Don't stop or message it unless the user asks or you know it should have finished.`
  const taskId = target.kind === 'local' ? target.dispatch.task_id : target.attachment.task_id
  const payload = {
    taskId,
    dispatchId: worker.dispatchId,
    handle: worker.from,
    quietNotice: notice
  }
  if (target.kind === 'local') {
    escalateWorkerFailure(
      db,
      target.dispatch,
      {
        id,
        from: worker.from,
        notice: true,
        mailbox: () => dispatchReportMailbox(db, target.dispatch),
        describe: () => ({ subject, body }),
        payload
      },
      notify
    )
    return db.getMessageById(id) !== undefined
  }
  try {
    db.enqueueFederationRelay({
      dispatchId: worker.dispatchId,
      direction: 'to_home',
      kind: 'status',
      messageId: id,
      payload: JSON.stringify({
        from: worker.from,
        subject,
        body,
        type: 'status',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify(payload)
      })
    })
    return true
  } catch (error) {
    console.warn('[orchestration] failed to relay a quiet worker notice', worker.dispatchId, error)
    return false
  }
}
