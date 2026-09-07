import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { AmbiguousDispatchParentError } from './dispatch-depth'

/**
 * These pin the fence Orca documented but never enforced: before this feature a
 * dispatched worker could create its own Run and dispatch sub-workers freely.
 * Every rejection case here passes on the pre-change tree.
 */
describe('nested worker depth', () => {
  let db: OrchestrationDb
  const SYSTEM = { kind: 'system' } as const
  const UNCAPPED = Number.MAX_SAFE_INTEGER

  afterEach(() => db?.close())

  function coordinatorDispatchesWorker(maxDepth = UNCAPPED) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'root task' })
    const worker = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      assigneePaneKey: 'tab_worker:leaf_worker',
      creator: SYSTEM,
      maxDepth
    })
    return worker
  }

  it('stamps a root coordinator dispatch at depth 1', () => {
    expect(coordinatorDispatchesWorker().depth).toBe(1)
  })

  it('refuses a worker dispatching a sub-worker at the default cap', () => {
    coordinatorDispatchesWorker()
    const nested = db.createTask({ spec: 'nested task' })
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
    ).toThrow(/depth 2 \(max 1\)/)
  })

  it('tells the refused worker to complete the task itself', () => {
    coordinatorDispatchesWorker()
    const nested = db.createTask({ spec: 'nested task' })
    expect(() =>
      db.createDispatchContext({
        taskId: nested.id,
        assigneeHandle: 'term_sub',
        creator: { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
        maxDepth: 1
      })
    ).toThrow(/Complete this task yourself/)
  })

  it('permits one more generation when the cap is raised, and records depth 2', () => {
    coordinatorDispatchesWorker()
    const nested = db.createTask({ spec: 'nested task' })
    const sub = db.createDispatchContext({
      taskId: nested.id,
      assigneeHandle: 'term_sub',
      assigneePaneKey: 'tab_sub:leaf_sub',
      creator: { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
      maxDepth: 2
    })
    expect(sub.depth).toBe(2)
  })

  it('closes the run-create bypass: a fresh Run does not reset the creator depth', () => {
    // The old fence keyed off Run binding, so a worker that created its own Run
    // walked straight through. Depth comes from the creator's dispatch instead.
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
    ).toThrow(/depth 2 \(max 1\)/)
  })

  it('treats the in-process coordinator loop as a root even from a worker pane', () => {
    coordinatorDispatchesWorker()
    expect(db.resolveCreatorDepth({ kind: 'system' })).toBe(0)
  })

  it('resolves an unknown terminal to root depth', () => {
    db = new OrchestrationDb(':memory:')
    expect(db.resolveCreatorDepth({ kind: 'terminal', handle: 'term_nobody' })).toBe(0)
  })

  describe('remote attachments as parents', () => {
    const PANE = 'tab_remote:leaf_remote'
    const INCARNATION = 'inc-1'

    function attachRemoteWorker(state: string, depth: number, paneKey = PANE, inc = INCARNATION) {
      db.db
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch,
              pane_key, process_incarnation, state, depth)
           VALUES (?, ?, 'peer', 1, 'epoch', ?, ?, ?, ?)`
        )
        .run(`ctx_${state}_${depth}_${paneKey}_${inc}`, 'task_remote', paneKey, inc, state, depth)
    }

    // Loss of contact is never evidence of process death: an unverifiable remote
    // worker must still block nesting. See docs/reference/ssh-execution-boundary.md.
    for (const state of ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown']) {
      it(`counts a '${state}' attachment as a live parent`, () => {
        db = new OrchestrationDb(':memory:')
        attachRemoteWorker(state, 1)
        expect(
          db.resolveCreatorDepth({
            kind: 'terminal',
            handle: 'term_remote',
            paneKey: PANE,
            processIncarnation: INCARNATION
          })
        ).toBe(1)
      })
    }

    for (const state of ['succeeded', 'failed', 'stopped', 'abandoned']) {
      it(`does not count a settled '${state}' attachment`, () => {
        db = new OrchestrationDb(':memory:')
        attachRemoteWorker(state, 1)
        expect(
          db.resolveCreatorDepth({
            kind: 'terminal',
            handle: 'term_remote',
            paneKey: PANE,
            processIncarnation: INCARNATION
          })
        ).toBe(0)
      })
    }

    it('ignores an attachment whose pane was reused by a new process', () => {
      db = new OrchestrationDb(':memory:')
      attachRemoteWorker('ready', 2)
      expect(
        db.resolveCreatorDepth({
          kind: 'terminal',
          handle: 'term_remote',
          paneKey: PANE,
          processIncarnation: 'inc-2'
        })
      ).toBe(0)
    })

    it('fails closed when one identity matches two live attachments', () => {
      db = new OrchestrationDb(':memory:')
      attachRemoteWorker('ready', 1)
      attachRemoteWorker('starting', 2)
      expect(() =>
        db.resolveCreatorDepth({
          kind: 'terminal',
          handle: 'term_remote',
          paneKey: PANE,
          processIncarnation: INCARNATION
        })
      ).toThrow(AmbiguousDispatchParentError)
    })

    it('takes the maximum when a process holds both a local and a remote role', () => {
      // Query order must not decide the answer: the deeper role governs.
      db = new OrchestrationDb(':memory:')
      const task = db.createTask({ spec: 'local role' })
      db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: 'term_both',
        assigneePaneKey: PANE,
        creator: { kind: 'system' },
        maxDepth: UNCAPPED
      })
      attachRemoteWorker('ready', 3)
      expect(
        db.resolveCreatorDepth({
          kind: 'terminal',
          handle: 'term_both',
          paneKey: PANE,
          processIncarnation: INCARNATION
        })
      ).toBe(3)
    })
  })

  describe('the supervised worker-start path', () => {
    // r2 put enforcement in createDispatchContext and missed this entirely:
    // worker-start has its own insert, and so does every retry through it.
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

    it('stamps depth 1 for a root coordinator', () => {
      db = new OrchestrationDb(':memory:')
      const task = db.createTask({ spec: 'root work' })
      expect(startWorker(task.id, SYSTEM, UNCAPPED).dispatch.depth).toBe(1)
    })

    it('refuses a worker starting a sub-worker at the default cap', () => {
      coordinatorDispatchesWorker()
      const nested = db.createTask({ spec: 'nested work' })
      expect(() =>
        startWorker(
          nested.id,
          { kind: 'terminal', handle: 'term_worker', paneKey: 'tab_worker:leaf_worker' },
          1
        )
      ).toThrow(/depth 2 \(max 1\)/)
    })

    it('refuses a worker retrying into a sub-worker at the default cap', () => {
      coordinatorDispatchesWorker()
      const nested = db.createTask({ spec: 'nested retry work' })
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
      ).toThrow(/depth 2 \(max 1\)/)
    })
  })

  it('keeps a local row with a null process incarnation eligible as a parent', () => {
    // Context-only dispatch stores null on purpose; requiring an incarnation
    // locally would silently drop real parents and fail open.
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'context only' })
    const row = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_ctx',
      assigneePaneKey: 'tab_ctx:leaf_ctx',
      creator: { kind: 'system' },
      maxDepth: UNCAPPED
    })
    expect(row.process_incarnation).toBeNull()
    expect(db.resolveCreatorDepth({ kind: 'terminal', handle: 'term_ctx' })).toBe(1)
  })
})
