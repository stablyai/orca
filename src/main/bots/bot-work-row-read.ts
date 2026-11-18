import type { BotWorkCloseReason, BotWorkRow } from './bot-work-store'
import type { BotWorkCheck, BotWorkRecordDeps, BotWorkWorker } from './bot-work-types'

/** A row's worker and workspace as they are now, or the proof that its work is over. */
export async function readBotWorkRow(
  deps: Pick<BotWorkRecordDeps, 'worker' | 'workspace'>,
  row: BotWorkRow
): Promise<BotWorkCheck | { closeReason: BotWorkCloseReason }> {
  let worker: BotWorkWorker | null
  try {
    worker = await deps.worker(row.dispatchId)
  } catch {
    return { row, worker: null, workspace: null }
  }
  if (!worker || worker.host !== row.host) {
    return { closeReason: 'task_gone' }
  }
  if (worker.stopped) {
    return { closeReason: 'stopped' }
  }
  if (worker.startFailed) {
    return { closeReason: 'start_failed' }
  }
  const workspace = await deps.workspace(worker).catch(() => null)
  return workspace === 'gone' ? { closeReason: 'workspace_gone' } : { row, worker, workspace }
}
