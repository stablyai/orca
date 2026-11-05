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

/** One question to one host, never per worker: which of its finished workers are still heard, and which left
 *  mail. Only those with mail are synced, plus any with an answer to deliver. 'listening' while the host still
 *  hears one, which lapses on its own once they stop writing. */
export async function pullFinishedWorkerMail(
  db: OrchestrationDb,
  environmentId: string,
  host: {
    ask: (environmentId: string) => Promise<unknown>
    sync: (dispatchId: string) => Promise<void>
    isCurrent: () => boolean
  }
): Promise<FinishedWorkerHostRound> {
  const reply = FinishedWorkersReply.safeParse(await host.ask(environmentId).catch(() => null))
  if (!reply.success) {
    return 'unreachable'
  }
  let failed = false
  for (const worker of db.listFinishedFederatedWorkers()) {
    if (
      worker.environmentId !== environmentId ||
      !(worker.answerPending || reply.data.mail.includes(worker.dispatchId))
    ) {
      continue
    }
    if (!host.isCurrent()) {
      return 'done'
    }
    await host.sync(worker.dispatchId).catch(() => {
      failed = true
    })
  }
  return failed ? 'unreachable' : reply.data.open.length > 0 ? 'listening' : 'done'
}

const FinishedWorkersReply = z.object({ open: z.array(z.string()), mail: z.array(z.string()) })

const FINISHED_MAIL_INTERVAL_MS = 5_000
const FINISHED_MAIL_RETRIES = 5

/** At most one round per host, even across a reset; one asked for meanwhile runs after it. A failing host is
 *  retried less often, never sooner when asked again, then left alone until it answers some other call. */
export class FinishedWorkerMailRounds {
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Set<string>()
  private readonly again = new Set<string>()
  private readonly failures = new Map<string, number>()
  private generation = 0

  constructor(
    private readonly round: (environmentId: string) => Promise<FinishedWorkerHostRound>
  ) {}

  ensure(environmentIds: Iterable<string>): void {
    for (const environmentId of environmentIds) {
      if (this.running.has(environmentId)) {
        this.again.add(environmentId)
      } else if (!this.scheduled.has(environmentId) && !this.isExhausted(environmentId)) {
        this.schedule(environmentId, 0)
      }
    }
  }

  /** A host that answered again gets another round if it had been given up on. */
  revive(environmentId: string): void {
    if (this.isExhausted(environmentId)) {
      this.failures.delete(environmentId)
      this.ensure([environmentId])
    }
  }

  stop(): void {
    this.generation += 1
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer)
    }
    this.scheduled.clear()
    this.again.clear()
    this.failures.clear()
  }

  private isExhausted(environmentId: string): boolean {
    return (this.failures.get(environmentId) ?? 0) > FINISHED_MAIL_RETRIES
  }

  private schedule(environmentId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.scheduled.delete(environmentId)
      this.run(environmentId)
    }, delayMs)
    timer.unref?.()
    this.scheduled.set(environmentId, timer)
  }

  private run(environmentId: string): void {
    const generation = this.generation
    this.running.add(environmentId)
    void this.round(environmentId)
      .catch((): FinishedWorkerHostRound => 'unreachable')
      .then((round) => {
        this.running.delete(environmentId)
        const again = this.again.delete(environmentId)
        if (generation !== this.generation) {
          if (again) {
            this.schedule(environmentId, 0)
          }
          return
        }
        if (round === 'unreachable') {
          const failures = (this.failures.get(environmentId) ?? 0) + 1
          this.failures.set(environmentId, failures)
          if (failures <= FINISHED_MAIL_RETRIES) {
            this.schedule(environmentId, FINISHED_MAIL_INTERVAL_MS * 2 ** (failures - 1))
          }
          return
        }
        this.failures.delete(environmentId)
        if (again || round === 'listening') {
          this.schedule(environmentId, again ? 0 : FINISHED_MAIL_INTERVAL_MS)
        }
      })
  }
}
