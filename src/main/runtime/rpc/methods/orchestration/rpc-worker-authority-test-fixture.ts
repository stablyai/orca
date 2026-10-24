import type { OrchestrationDb } from '../../../orchestration/db'

export const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const WORKER_PROCESS = 'runtime_test:term_worker:1'

export function startRpcWorker(
  db: OrchestrationDb,
  runId: string,
  options: { handle?: string; paneKey?: string; processIncarnation?: string; ready?: boolean } = {}
) {
  const task = db.createTask({ runId, spec: 'Owned worker assignment' })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: options.handle ?? 'term_worker',
    paneKey: options.paneKey ?? WORKER_PANE,
    processIncarnation: options.processIncarnation ?? WORKER_PROCESS,
    worktreeId: 'folder-owned-worker',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  if (options.ready !== false) {
    db.markWorkerDispatchReady(started.dispatch.id)
  }
  return { taskId: task.id, dispatchId: started.dispatch.id }
}
