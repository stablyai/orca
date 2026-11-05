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

export type FinishedWorkerHostRound = 'listening' | 'done' | 'unreachable'

/** One question to one host, never per worker: which of its finished workers are still open, left mail, or
 *  closed. Only those are synced, plus open ones with an answer to deliver; a closed one is drained, then
 *  retired. 'listening' while the host keeps any worker open, so the home stops once all of them rest. */
export async function pullFinishedWorkerMail(
  db: OrchestrationDb,
  environmentId: string,
  host: {
    ask: (environmentId: string) => Promise<unknown>
    sync: (dispatchId: string) => Promise<void>
    retire: (dispatchId: string) => void
    isCurrent: () => boolean
  }
): Promise<FinishedWorkerHostRound> {
  const finished = db
    .listFinishedFederatedWorkers()
    .filter((worker) => worker.environmentId === environmentId)
  if (finished.length === 0) {
    return 'done'
  }
  const reply = FinishedWorkersReply.safeParse(await host.ask(environmentId).catch(() => null))
  if (!reply.success) {
    return 'unreachable'
  }
  const { open, mail, released } = reply.data
  for (const { dispatchId, answerPending } of finished) {
    if (
      !(
        mail.includes(dispatchId) ||
        released.includes(dispatchId) ||
        (answerPending && open.includes(dispatchId))
      )
    ) {
      continue
    }
    if (!host.isCurrent()) {
      return 'done'
    }
    await host.sync(dispatchId).catch(() => undefined)
    if (released.includes(dispatchId) && host.isCurrent()) {
      host.retire(dispatchId)
    }
  }
  return finished.some(({ dispatchId }) => open.includes(dispatchId)) ? 'listening' : 'done'
}

const FinishedWorkersReply = z.object({
  open: z.array(z.string()),
  mail: z.array(z.string()),
  released: z.array(z.string())
})

const FINISHED_MAIL_INTERVAL_MS = 5_000
const FINISHED_MAIL_RETRIES = 5

/** One round per host at a time, the next only after it, slower than a live worker's tick. A host that keeps
 *  failing is retried less often, then left until one of its workers finishes again. */
export class FinishedWorkerMailRounds {
  private readonly hosts = new Map<string, ReturnType<typeof setTimeout>>()
  private generation = 0

  constructor(
    private readonly round: (environmentId: string) => Promise<FinishedWorkerHostRound>
  ) {}

  ensure(environmentIds: Iterable<string>): void {
    for (const environmentId of environmentIds) {
      if (!this.hosts.has(environmentId)) {
        this.schedule(environmentId, 0, 0)
      }
    }
  }

  stop(): void {
    this.generation += 1
    for (const timer of this.hosts.values()) {
      clearTimeout(timer)
    }
    this.hosts.clear()
  }

  private schedule(environmentId: string, delayMs: number, failures: number): void {
    const generation = this.generation
    const timer = setTimeout(() => {
      void this.round(environmentId)
        .catch((): FinishedWorkerHostRound => 'unreachable')
        .then((round) => {
          if (generation !== this.generation) {
            return
          }
          this.hosts.delete(environmentId)
          if (round === 'listening') {
            this.schedule(environmentId, FINISHED_MAIL_INTERVAL_MS, 0)
          } else if (round === 'unreachable' && failures < FINISHED_MAIL_RETRIES) {
            this.schedule(environmentId, FINISHED_MAIL_INTERVAL_MS * 2 ** failures, failures + 1)
          }
        })
    }, delayMs)
    timer.unref?.()
    this.hosts.set(environmentId, timer)
  }
}
