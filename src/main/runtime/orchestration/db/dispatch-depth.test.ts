import { afterEach, describe, expect, it } from 'vitest'

import { OrchestrationDb } from './orchestration-db'
import './contract-constants'
import './messages/mailbox-routing-page'
import './dispatch-row-writer'
import './attempt-outcome-projection'

/** Enforce nesting depth even when a worker creates its own Run. */
describe('nested worker depth', () => {
  let db: OrchestrationDb
  const SYSTEM = { kind: 'system' } as const
  const UNCAPPED = Number.MAX_SAFE_INTEGER

  afterEach(() => db?.close())

  function coordinatorDispatchesWorker(maxDepth = UNCAPPED) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'root task' })
    const worker = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      assigneePaneKey: 'tab_worker:leaf_worker',
      creator: SYSTEM,
      maxDepth
    })
    return worker
  }

  it('refuses a worker dispatching a sub-worker at the default cap', () => {
    coordinatorDispatchesWorker()
    const nested = db.createTask({ runId: 'run_legacy_local', spec: 'nested task' })
    expect(() =>
      db.createDispatchContext({
        taskId: nested.id,
        assigneeHandle: 'term_sub',
        assigneePaneKey: 'tab_sub:leaf_sub',
        creator: {
          kind: 'terminal',
          handle: 'term_worker',
          paneKey: 'tab_worker:leaf_worker'
        },
        maxDepth: 1
      })
    ).toThrow(/at most 1 level deep, so this worker can't start another \(depth 2\)/)
  })

  it('closes the run-create bypass: a fresh Run does not reset the creator depth', () => {
    // A worker-created Run must not evade depth derived from its creator Dispatch.
    coordinatorDispatchesWorker()
    const ownRun = db.createRun({
      objective: 'worker-owned run',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: 'tab_worker:leaf_worker'
    })
    const nested = db.createTask({ spec: 'nested task', runId: ownRun.id })
    expect(() =>
      db.createDispatchContext({
        taskId: nested.id,
        assigneeHandle: 'term_sub',
        creator: { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
        maxDepth: 1
      })
    ).toThrow(/at most 1 level deep, so this worker can't start another \(depth 2\)/)
  })

  describe('the supervised worker-start path', () => {
    // worker-start and its retries insert separately from createDispatchContext and need the same depth fence.
    function startWorker(
      taskId: string,
      creator: Parameters<OrchestrationDb['resolveCreatorDepth']>[0],
      maxDepth: number
    ) {
      return db.createStartingWorkerDispatch({
        taskId,
        startOptions: {},
        creator,
        maxDepth
      })
    }

    it('refuses a worker starting a sub-worker at the default cap', () => {
      coordinatorDispatchesWorker()
      const nested = db.createTask({
        runId: 'run_legacy_local',
        spec: 'nested work'
      })
      expect(() =>
        startWorker(
          nested.id,
          { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
          1
        )
      ).toThrow(/at most 1 level deep, so this worker can't start another \(depth 2\)/)
    })

    it('refuses a worker retrying into a sub-worker at the default cap', () => {
      coordinatorDispatchesWorker()
      const nested = db.createTask({
        runId: 'run_legacy_local',
        spec: 'nested retry work'
      })
      const first = startWorker(nested.id, SYSTEM, UNCAPPED)
      db.failWorkerStart(first.dispatch.id, 'accepted', 'first attempt failed')
      expect(() =>
        db.createStartingWorkerDispatch({
          taskId: nested.id,
          startOptions: {},
          retryOf: first.dispatch.id,
          creator: { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
          maxDepth: 1
        })
      ).toThrow(/at most 1 level deep, so this worker can't start another \(depth 2\)/)
    })
  })
})
