import type { BotWorkCloseReason, BotWorkHost, BotWorkRow } from './bot-work-store'
import type { BotWorkCheck, BotWorkRecordDeps, BotWorkWorker } from './bot-work-types'

export type BotWorkRowRead = BotWorkCheck | { row: BotWorkRow; closeReason: BotWorkCloseReason }

type WorkerRead =
  | { row: BotWorkRow; worker: BotWorkWorker | null }
  | { row: BotWorkRow; closeReason: BotWorkCloseReason }

/** The proof a row's work is over from its worker as read, or the worker to read on with. */
function judge(
  row: BotWorkRow,
  workers: ReadonlyMap<string, BotWorkWorker | null> | null
): WorkerRead {
  // Left out of the read: it couldn't be read, which proves nothing.
  if (!workers?.has(row.dispatchId)) {
    return { row, worker: null }
  }
  const worker = workers.get(row.dispatchId) ?? null
  if (!worker || worker.host !== row.host) {
    return { row, closeReason: 'task_gone' }
  }
  if (worker.stopped) {
    return { row, closeReason: 'stopped' }
  }
  return worker.startFailed ? { row, closeReason: 'start_failed' } : { row, worker }
}

/** Each row's worker and workspace as they are now, or the proof that its work is over. One worker
 *  read per host covers its rows, since each read walks the machine's whole agent fleet; per host, so
 *  a slow paired server never holds up this machine's rows. Proofs come first, while the read is
 *  fresh: a workspace wait could outlive it (a follow-up revives a stopped worker). */
export async function* readBotWorkRows(
  deps: Pick<BotWorkRecordDeps, 'workers' | 'workspaces'>,
  rows: readonly BotWorkRow[]
): AsyncGenerator<BotWorkRowRead> {
  const workspace = deps.workspaces()
  const hosts = new Map<BotWorkHost, Map<BotWorkRow, WorkerRead>>()
  for (const row of rows) {
    let reads = hosts.get(row.host)
    if (!reads) {
      const batch = rows.filter((entry) => entry.host === row.host)
      const workers = await deps.workers(batch.map((entry) => entry.dispatchId)).catch(() => null)
      reads = new Map(batch.map((entry) => [entry, judge(entry, workers)]))
      hosts.set(row.host, reads)
      for (const read of reads.values()) {
        if ('closeReason' in read) {
          yield read
        }
      }
    }
    const read = reads.get(row)
    if (!read || 'closeReason' in read) {
      continue
    }
    if (!read.worker) {
      yield { row, worker: null, workspace: null }
      continue
    }
    const found = await workspace(read.worker).catch(() => null)
    yield found === 'gone'
      ? { row, closeReason: 'workspace_gone' }
      : { row, worker: read.worker, workspace: found }
  }
}
