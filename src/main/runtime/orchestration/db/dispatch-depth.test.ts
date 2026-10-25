import { afterEach, describe, expect, it } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../structured-worker-identity'
import { OrchestrationDb } from '../db'
import { AmbiguousDispatchParentError } from './dispatch-depth'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'

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

  it('stamps a root coordinator dispatch at depth 1', () => {
    expect(coordinatorDispatchesWorker().depth).toBe(1)
  })

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
    ).toThrow(/depth 2 \(max 1\)/)
  })

  it('tells the refused worker to complete the task itself', () => {
    coordinatorDispatchesWorker()
    const nested = db.createTask({ runId: 'run_legacy_local', spec: 'nested task' })
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
    const nested = db.createTask({ runId: 'run_legacy_local', spec: 'nested task' })
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
             (dispatch_id, task_id, home_run_id, home_peer_fingerprint, protocol_version, runtime_epoch,
              pane_key, process_incarnation, state, depth)
           VALUES (?, ?, 'run_home', 'peer', 1, 'epoch', ?, ?, ?, ?)`
        )
        .run(`ctx_${state}_${depth}_${paneKey}_${inc}`, 'task_remote', paneKey, inc, state, depth)
    }

    // Lost remote contact cannot prove exit; unverifiable workers still block nesting (docs/reference/ssh-execution-boundary.md).
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
      db = new OrchestrationDb(':memory:')
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'local role'
      })
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

    it('stamps depth 1 for a root coordinator', () => {
      db = new OrchestrationDb(':memory:')
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'root work'
      })
      expect(startWorker(task.id, SYSTEM, UNCAPPED).dispatch.depth).toBe(1)
    })

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
      ).toThrow(/depth 2 \(max 1\)/)
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
      ).toThrow(/depth 2 \(max 1\)/)
    })
  })

  it('keeps a local row with a null process incarnation eligible as a parent', () => {
    // Context-only local Dispatches deliberately lack incarnation; requiring it would drop live parents.
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'context only'
    })
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

  // Equal session ids mean self-bookkeeping; different ids mean delegation.
  it('records equal Orca session ids exactly when a structured session dispatches to itself', () => {
    db = new OrchestrationDb(':memory:')
    const sessionId = '5c7e9a1d-3f6b-4c8e-8d2a-4b6c8e0a2d36'
    const self = {
      kind: 'terminal',
      handle: mintStructuredWorkerHandle(),
      paneKey: mintStructuredWorkerPaneKey(sessionId)
    } as const
    const own = db.createDispatchContext({
      taskId: db.createTask({ runId: 'run_legacy_local', spec: 'own bookkeeping' }).id,
      assigneeHandle: self.handle,
      assigneePaneKey: self.paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      creator: self,
      maxDepth: UNCAPPED
    })
    const delegated = db.createDispatchContext({
      taskId: db.createTask({ runId: 'run_legacy_local', spec: 'delegated' }).id,
      assigneeHandle: 'term_delegate',
      assigneePaneKey: 'tab_delegate:22222222-2222-4222-8222-222222222222',
      creator: self,
      maxDepth: UNCAPPED
    })
    backfillStructuredWorkerOrcaSessionIds(db.db)

    const ownRow = db.getDispatchContextById(own.id)
    expect(ownRow?.creator_orca_session_id).toBe(sessionId)
    expect(ownRow?.assignee_orca_session_id).toBe(ownRow?.creator_orca_session_id)
    expect(db.resolveCreatorDepth(self)).toBe(0)
    const delegatedRow = db.getDispatchContextById(delegated.id)
    expect(delegatedRow?.creator_orca_session_id).toBe(sessionId)
    expect(delegatedRow?.assignee_orca_session_id).toBeNull()
    expect(
      db.resolveCreatorDepth({
        kind: 'terminal',
        handle: 'term_delegate',
        paneKey: 'tab_delegate:22222222-2222-4222-8222-222222222222'
      })
    ).toBe(1)
  })
})
