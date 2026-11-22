import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { restartResumedCallerHandle } from './restart-resumed-caller'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

function resumedWorker(stage: string): OrchestrationDb {
  db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'reboot',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = db.createTask({ spec: 'keep working', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'claude' }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term_resumed',
    paneKey: 'tab_new:leaf_new',
    processIncarnation: 'pty-new:11111111-1111-4111-8111-111111111111',
    worktreeId: 'repo::/tmp/repo',
    setupState: 'not_applicable',
    effects: []
  })
  db.markWorkerDispatchReady(dispatch.id)
  db.db
    .prepare('UPDATE worker_dispatches SET stage = ? WHERE dispatch_id = ?')
    .run(stage, dispatch.id)
  return db
}

const runtime = (orchestrationDb: OrchestrationDb) => ({
  getLiveTerminalPaneKey: (handle: string) =>
    handle === 'term_resumed' ? 'tab_new:leaf_new' : null,
  getTerminalHandleForPaneKey: (paneKey: string) =>
    paneKey === 'tab_new:leaf_new' ? 'term_resumed' : null,
  getExistingOrchestrationDb: () => orchestrationDb
})

describe('restartResumedCallerHandle', () => {
  it('lets a resumed worker report as its new terminal under its brief’s old handle', () => {
    const orchestrationDb = resumedWorker('restart_resumed')
    expect(
      restartResumedCallerHandle(runtime(orchestrationDb), 'term_brief_handle', {
        paneKey: 'tab_new:leaf_new'
      })
    ).toBe('term_resumed')
  })

  it('leaves a worker that was never resumed as it names itself', () => {
    const orchestrationDb = resumedWorker('input_accepted')
    expect(
      restartResumedCallerHandle(runtime(orchestrationDb), 'term_brief_handle', {
        paneKey: 'tab_new:leaf_new'
      })
    ).toBeNull()
  })
})
