import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'

const PANE = 'worker-tab:11111111-1111-4111-8111-111111111111'
const HOST = JSON.stringify({ kind: 'local', hostId: 'local' })
let db: OrchestrationDb

afterEach(() => {
  db?.close()
})

function startWorker(
  ownership: 'created' | 'external',
  processIncarnation: string,
  sleptProcessIncarnation?: string
) {
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec: 'Reply PONG',
    taskRunId: 'run_legacy_local',
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_worker',
    paneKey: PANE,
    processIncarnation,
    hostScope: HOST,
    worktreeId: '/workspace',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: ownership,
    sleptProcessIncarnation
  })
  return started
}

it("keeps Orca's custody when a worker reuses a slept worker's pane after its resume", () => {
  db = new OrchestrationDb(':memory:')
  const first = startWorker('created', 'pty-stopped:inc-stopped')
  db.markWorkerDispatchReady(first.dispatch.id)
  db.settleWorkerReport({
    taskId: first.task.id,
    dispatchId: first.dispatch.id,
    outcome: 'succeeded',
    result: '{}'
  })

  const second = startWorker('external', 'pty-resumed:inc-resumed', 'pty-stopped:inc-stopped')

  expect(db.getWorkerTerminalResourceByOwner(second.dispatch.id)).toMatchObject({
    ownership_state: 'owned',
    process_incarnation: 'pty-resumed:inc-resumed'
  })
})
