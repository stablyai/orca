import { ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION } from '../../../shared/orchestration-runtime-capabilities'
import type { OrchestrationDb } from './db'
import type { RemoteDispatchAttachmentRow } from './types'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from './db/federation/remote-attachment-liveness'
import { isWorkerStateIn } from './worker-report-admission'

/** A settled remote Dispatch whose Run home keeps pulling it, so its worker's later mail still arrives. */
export function takesFinishedWorkerMail(
  attachment: Pick<RemoteDispatchAttachmentRow, 'state' | 'protocol_version'>
): boolean {
  return (
    !isWorkerStateIn(POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES, attachment.state) &&
    attachment.protocol_version >= ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION
  )
}

/** One question per host, never per worker: which finished workers left mail. Only those, and any with an
 *  answer to deliver, are synced. False once no finished worker is left to pull for. */
export async function pullFinishedWorkerMail(
  db: OrchestrationDb,
  askHost: (environmentId: string) => Promise<unknown>,
  sync: (dispatchId: string) => Promise<void>
): Promise<boolean> {
  const finished = db.listFinishedFederatedWorkers()
  for (const environmentId of new Set(finished.map((worker) => worker.environmentId))) {
    const reply = await askHost(environmentId).catch(() => undefined)
    const ids =
      reply &&
      typeof reply === 'object' &&
      'dispatchIds' in reply &&
      Array.isArray(reply.dispatchIds)
        ? reply.dispatchIds
        : []
    for (const worker of finished) {
      if (
        worker.environmentId === environmentId &&
        (worker.answerPending || ids.includes(worker.dispatchId))
      ) {
        await sync(worker.dispatchId).catch(() => undefined)
      }
    }
  }
  return finished.length > 0
}
