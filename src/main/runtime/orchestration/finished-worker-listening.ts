import type { OrchestrationDb } from './db'
import type { FinishedRemoteWorker } from './db/federation/federation-relay-ack'
import type { RemoteDispatchAttachmentRow } from './types'
import { exposeUtcTimestamp } from './db/utc-timestamp'

/** How long a Run home keeps listening to a finished worker here after it last worked. */
export const FINISHED_WORKER_LISTENING_GRACE_MS = 2 * 60_000

export type FinishedWorkersReport = { open: string[]; mail: string[]; released: string[] }

// Per database, the finished workers whose Run home still listens, by when each last worked. A worker leaves only
// when this host tells its home it stopped listening, so nothing it accepts is left unread.
const listening = new WeakMap<OrchestrationDb, Map<string, number>>()

function listeningOn(db: OrchestrationDb): Map<string, number> {
  let workers = listening.get(db)
  if (!workers) {
    workers = new Map()
    listening.set(db, workers)
  }
  return workers
}

function settledAt(attachment: Pick<RemoteDispatchAttachmentRow, 'updated_at'>): number {
  return Date.parse(exposeUtcTimestamp(attachment.updated_at) ?? '') || 0
}

/** Answers a Run home's round: a finished worker stays open while it works or has mail, and for a grace after;
 *  past that the home stops listening, so a resting worker never keeps it polling. */
export function reportFinishedWorkers(
  db: OrchestrationDb,
  homePeerFingerprint: string,
  inTurn: (worker: FinishedRemoteWorker) => boolean,
  now = Date.now()
): FinishedWorkersReport {
  const workers = listeningOn(db)
  const report: FinishedWorkersReport = { open: [], mail: [], released: [] }
  for (const worker of db.listFinishedRemoteWorkers(homePeerFingerprint)) {
    const id = worker.dispatch_id
    const busy = worker.mail || (!worker.released && inTurn(worker))
    const lastWorked = busy ? now : Math.max(workers.get(id) ?? 0, settledAt(worker))
    if (worker.mail) {
      report.mail.push(id)
    }
    if (worker.released) {
      report.released.push(id)
    }
    if (
      worker.mail ||
      (!worker.released && now - lastWorked < FINISHED_WORKER_LISTENING_GRACE_MS)
    ) {
      workers.set(id, lastWorked)
      report.open.push(id)
    } else {
      workers.delete(id)
    }
  }
  return report
}

/** Whether a finished worker's mail will be read: its home listens, or it finished too recently for a round. */
export function isFinishedWorkerHeard(
  db: OrchestrationDb,
  attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'updated_at'>,
  now = Date.now()
): boolean {
  return (
    listeningOn(db).has(attachment.dispatch_id) ||
    now - settledAt(attachment) < FINISHED_WORKER_LISTENING_GRACE_MS
  )
}
