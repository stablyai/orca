import { z } from 'zod'
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

/** One question per host, never per worker, every host at once: which finished workers left mail, and which
 *  closed. Only those are synced, plus any with an answer to deliver; a closed one is drained, then retired.
 *  False once no finished worker is left to pull for. */
export async function pullFinishedWorkerMail(
  db: OrchestrationDb,
  host: {
    ask: (environmentId: string) => Promise<unknown>
    sync: (dispatchId: string) => Promise<void>
    retire: (dispatchId: string) => void
    isCurrent: () => boolean
  }
): Promise<boolean> {
  const finished = db.listFinishedFederatedWorkers()
  const environments = new Set(finished.map((worker) => worker.environmentId))
  await Promise.allSettled(
    [...environments].map(async (environmentId) => {
      const reply = FinishedWorkersReply.safeParse(await host.ask(environmentId).catch(() => null))
      const mail = reply.success ? reply.data.dispatchIds : []
      const released = reply.success ? reply.data.released : []
      for (const worker of finished) {
        const { dispatchId } = worker
        if (
          worker.environmentId !== environmentId ||
          !(worker.answerPending || mail.includes(dispatchId) || released.includes(dispatchId))
        ) {
          continue
        }
        if (!host.isCurrent()) {
          return
        }
        await host.sync(dispatchId).catch(() => undefined)
        if (released.includes(dispatchId) && host.isCurrent()) {
          host.retire(dispatchId)
        }
      }
    })
  )
  return finished.length > 0
}

const FinishedWorkersReply = z.object({
  dispatchIds: z.array(z.string()),
  released: z.array(z.string())
})
