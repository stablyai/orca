import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

describe('external worker-stop settlement', () => {
  let db: OrchestrationDb
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'external worker stop',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
  })

  afterEach(() => db.close())

  it('settles the assignment without claiming or releasing its external process', () => {
    const task = db.createTask({ runId, spec: 'external assignment' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_external',
      paneKey: 'tab_external:leaf',
      processIncarnation: 'pty-live:22222222-2222-4222-8222-222222222222',
      worktreeId: 'folder-workspace',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(dispatch.id)
    db.beginWorkerStop(dispatch.id, 'test-runtime')

    const worker = db.settleWorkerStop(dispatch.id, false)

    expect(worker).toMatchObject({ state: 'abandoned', stage: 'assignment_settled' })
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      last_failure: 'abandoned'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
      ownership_state: 'external',
      release_state: 'not_requested',
      retained_reason: 'external_terminal'
    })
  })
})
