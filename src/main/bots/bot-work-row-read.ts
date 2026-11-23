import type { BotWorkCloseReason, BotWorkRow } from './bot-work-store'
import type { BotWorkCheck, BotWorkRecordDeps } from './bot-work-types'

export type BotWorkRowRead = BotWorkCheck | { row: BotWorkRow; closeReason: BotWorkCloseReason }

/** Each row's worker and workspace as they are now, or the proof that its work is over, in row
 *  order. One worker read covers every row: each read walks the machine's whole agent fleet. */
export async function* readBotWorkRows(
  deps: Pick<BotWorkRecordDeps, 'workers' | 'workspaces'>,
  rows: readonly BotWorkRow[]
): AsyncGenerator<BotWorkRowRead> {
  if (rows.length === 0) {
    return
  }
  const workers = await deps.workers(rows.map((row) => row.dispatchId)).catch(() => null)
  const workspace = deps.workspaces()
  for (const row of rows) {
    if (!workers) {
      yield { row, worker: null, workspace: null }
      continue
    }
    const worker = workers.get(row.dispatchId) ?? null
    if (!worker || worker.host !== row.host) {
      yield { row, closeReason: 'task_gone' }
    } else if (worker.stopped) {
      yield { row, closeReason: 'stopped' }
    } else if (worker.startFailed) {
      yield { row, closeReason: 'start_failed' }
    } else {
      const read = await workspace(worker).catch(() => null)
      yield read === 'gone'
        ? { row, closeReason: 'workspace_gone' }
        : { row, worker, workspace: read }
    }
  }
}
