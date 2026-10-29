import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { readRunRemovedWork } from './db/reset/removed-orchestration-work-read'
import { settleWorkerForCompletedDispatch } from './db/worker-dispatch/worker-dispatch-settlement'

describe('OrchestrationDb reset scopes', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createState() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Reset contract',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { worktree: 'current' },
      runtimeEpoch: 'runtime_1',
      federation: {
        environmentId: 'environment_1',
        environmentName: 'Windows',
        peerFingerprint: 'peer_1',
        protocolVersion: 1
      },
      mutationReceipt: {
        callerFingerprint: 'caller_1',
        requestId: 'request_1',
        method: 'orchestration.workerStart',
        payloadHash: 'hash_1'
      }
    })
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'status'
    })
    const localQuestion = db.createQuestion({
      runId: run.id,
      dispatchId: started.dispatch.id,
      askerHandle: 'worker',
      question: 'Continue?'
    })
    db.enqueueFederationRelay({
      dispatchId: started.dispatch.id,
      direction: 'to_home',
      kind: 'question',
      payload: '{}',
      messageId: 'question_1',
      remoteQuestion: true
    })
    db.putStructuredPointerOperation({
      mailbox_handle: `dispatch:${started.dispatch.id}`,
      session_id: 'session_1',
      operation_id: '1700000000000-00112233445566778899aabbccddeeff',
      batch_fingerprint: 'fingerprint_1',
      minted_at_ms: 1_700_000_000_000
    })
    return { run, task, started, message, localQuestion }
  }

  // A child Task and worker created by a coordinator, plus a remote worker whose terminal outlives it in reset order.
  function addChildWork(state: ReturnType<typeof createState>) {
    const child = db!.createTask({
      runId: state.run.id,
      parentId: state.task.id,
      spec: 'child work',
      createdByTerminalHandle: 'term_worker'
    })
    const childDispatch = db!.createStartingWorkerDispatch({
      taskId: child.id,
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { worktree: 'current' }
    })
    const remote = db!.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_reset_fixture',
      runId: state.run.id,
      taskId: child.id,
      homePeerFingerprint: 'peer_remote',
      protocolVersion: 1,
      runtimeEpoch: 'remote_epoch',
      mutationReceipt: {
        callerFingerprint: 'peer_remote',
        requestId: 'remote_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_hash'
      }
    })
    const terminal = (dispatchId: string, handle: string) =>
      db!.createWorkerTerminalResourceStatement({
        dispatchId,
        worktreeId: null,
        terminalHandle: handle,
        paneKey: null,
        processIncarnation: `${handle}_process`,
        ownership: 'owned'
      })
    terminal(childDispatch.dispatch.id, 'term_child')
    return {
      child,
      childDispatch,
      remote,
      remoteTerminal: terminal(remote.dispatch_id, 'term_remote')
    }
  }

  it('resetAll clears Runs, worker/federation state, and messages', () => {
    const state = createState()

    db!.resetAll()

    expect(db!.listRuns().runs).toEqual([expect.objectContaining({ id: LEGACY_RUN_ID, legacy: 1 })])
    expect(db!.getTask(state.task.id)).toBeUndefined()
    expect(db!.getWorkerDispatch(state.started.dispatch.id)).toBeUndefined()
    expect(db!.getFederatedDispatch(state.started.dispatch.id)).toBeUndefined()
    const sqlite = (db as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } })
      .db
    expect(sqlite.prepare('SELECT * FROM run_coordinator_handles').all()).toEqual([])
    expect(sqlite.prepare('SELECT * FROM removed_orchestration_work').all()).toEqual([])
    // The ledger survives so a lost reset response cannot replay as a new mutation.
    expect(db!.getMutationReceipt('caller_1', 'request_1')).toBeDefined()
    expect(db!.getInbox()).toEqual([])
    expect(
      db!.listFederationRelay({
        dispatchId: state.started.dispatch.id,
        direction: 'to_home',
        afterSequence: 0
      })
    ).toEqual([])
    expect(
      db!.getStructuredPointerOperation(`dispatch:${state.started.dispatch.id}`)
    ).toBeUndefined()
  })

  it('resetTasks preserves Runs and messages while clearing every worker attachment', () => {
    const state = createState()

    db!.resetTasks()

    expect(db!.getRun(state.run.id)).toBeDefined()
    expect(db!.getMessageById(state.message.id)).toBeDefined()
    expect(db!.getTask(state.task.id)).toBeUndefined()
    expect(db!.getWorkerDispatch(state.started.dispatch.id)).toBeUndefined()
    expect(db!.getFederatedDispatch(state.started.dispatch.id)).toBeUndefined()
    expect(db!.getRemoteQuestion('question_1')).toBeUndefined()
    expect(db!.getMessageById(state.localQuestion.message.id)).toBeDefined()
    expect(db!.getQuestion(state.localQuestion.message.id)).toMatchObject({
      status: 'closed',
      closed_at: expect.any(String)
    })
    expect(() =>
      db!.answerQuestion({
        messageId: state.localQuestion.message.id,
        runId: state.run.id,
        consumerGeneration: state.run.consumer_generation,
        body: 'Yes'
      })
    ).toThrowError(expect.objectContaining({ code: 'dispatch_inactive' }))
    expect(
      db!.getStructuredPointerOperation(`dispatch:${state.started.dispatch.id}`)
    ).toBeUndefined()
  })

  it('resetTasks records who created each removed Task, Dispatch and worker', () => {
    const state = createState()
    const { child, childDispatch, remote, remoteTerminal } = addChildWork(state)
    // A finished worker is settled without closing its agent: its owned terminal is never released.
    const childId = childDispatch.dispatch.id
    db!.db.exec(`UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = '${childId}'`)
    db!.db.exec(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = '${childId}'`)
    settleWorkerForCompletedDispatch(db!.db, childId)

    expect(db!.resetTasks()).toEqual({
      runs: 1,
      runIds: [state.run.id],
      tasks: 2,
      dispatches: 2,
      workers: 3,
      possiblyRunning: 3
    })

    const shown = readRunRemovedWork(db!.db, state.run.id, { removed: true })
    expect(shown).toMatchObject({
      coverage: 'complete',
      tasks: 2,
      dispatches: 2,
      workers: 3,
      terminals: 2,
      activeWorkersAtRemoval: 3,
      page: { hasMore: false, nextCursor: null }
    })
    expect(shown?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'task',
          id: child.id,
          parentTaskId: state.task.id,
          createdByHandle: 'term_worker'
        }),
        expect.objectContaining({
          kind: 'dispatch',
          id: childDispatch.dispatch.id,
          taskId: child.id,
          creatorHandle: 'term_coord'
        }),
        expect.objectContaining({
          kind: 'worker',
          id: childId,
          state: 'abandoned',
          activeAtRemoval: true
        }),
        expect.objectContaining({ kind: 'remote_worker', id: remote.dispatch_id }),
        // Its live Dispatch row was already gone; the Run comes from the recorded remote worker.
        expect.objectContaining({
          kind: 'terminal',
          id: remoteTerminal.id,
          ownerDispatchId: remote.dispatch_id
        }),
        expect.objectContaining({
          kind: 'federated_worker',
          id: state.started.dispatch.id,
          environmentName: 'Windows'
        })
      ])
    )
    // The federated worker's local worker row is folded into its one line, matching the count.
    expect(
      shown?.entries?.filter(
        (entry) => entry.id === state.started.dispatch.id && entry.kind !== 'dispatch'
      )
    ).toHaveLength(1)
  })

  it('does not count a worker with durable exit proof as possibly running', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Exit proof',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    // Each worker still owns an unreleased terminal; only a certified exit clears it.
    const ids = ['stopped', 'operator_close', 'unknown'].map((label) => {
      const task = db!.createTask({ runId: run.id, spec: label })
      const { dispatch } = db!.createStartingWorkerDispatch({
        taskId: task.id,
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        startOptions: { worktree: 'current' }
      })
      db!.createWorkerTerminalResourceStatement({
        dispatchId: dispatch.id,
        worktreeId: null,
        terminalHandle: `term_${label}`,
        paneKey: null,
        processIncarnation: `${label}_process`,
        ownership: 'owned'
      })
      const state = label === 'stopped' ? 'stopped' : 'failed'
      db!.db.exec(
        `UPDATE worker_dispatches SET state = '${state}' WHERE dispatch_id = '${dispatch.id}'`
      )
      if (label !== 'stopped') {
        db!.db.exec(
          `UPDATE dispatch_contexts SET status = 'failed', termination_reason = '${label}' WHERE id = '${dispatch.id}'`
        )
      }
      return dispatch.id
    })

    expect(db.resetTasks()).toMatchObject({ workers: 3, possiblyRunning: 1 })
    const workers = readRunRemovedWork(db.db, run.id, { removed: true })?.entries?.filter(
      (entry) => entry.kind === 'worker'
    )
    expect(workers?.map((entry) => 'activeAtRemoval' in entry && entry.activeAtRemoval)).toEqual(
      ids.map((id) => id === ids[2])
    )
  })

  it('records raw deletes from every lineage table, as an older binary would run them', () => {
    const state = createState()
    addChildWork(state)
    // Neither a BLOB in a text column nor removing the same id twice may fail the delete.
    db!.db.exec(`UPDATE tasks SET task_title = x'00ff' WHERE id = '${state.task.id}'`)
    for (const table of [
      'tasks',
      'dispatch_contexts',
      'worker_dispatches',
      'worker_terminal_resources',
      'remote_dispatch_attachments',
      'federated_dispatches'
    ]) {
      db!.db.exec(`DELETE FROM ${table}`)
    }
    db!.db.exec(
      `INSERT INTO tasks (id, run_id, spec) VALUES ('${state.task.id}', '${state.run.id}', 'again')`
    )
    db!.db.exec('DELETE FROM tasks')

    const rows = db!.db
      .prepare(
        'SELECT kind, run_id, COUNT(*) AS n FROM removed_orchestration_work GROUP BY kind, run_id'
      )
      .all()
    expect(rows).toEqual(
      expect.arrayContaining(
        [
          ['task', 3],
          ['dispatch', 2],
          ['worker', 2],
          ['terminal', 2],
          ['remote_worker', 1],
          ['federated_worker', 1]
        ].map(([kind, n]) => ({ kind, run_id: state.run.id, n }))
      )
    )
    expect(rows).toHaveLength(6)
  })

  it('never reads a Run older than the record as complete, and moves coverage when capture was missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-removed-work-coverage-'))
    const path = join(tempDir, 'orchestration.db')
    try {
      db = new OrchestrationDb(path)
      const run = db.createRun({
        objective: 'Older Run',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      db.db.exec(`UPDATE runs SET created_at = '2000-01-02 00:00:00' WHERE id = '${run.id}'`)
      expect(readRunRemovedWork(db.db, run.id, {})).toMatchObject({ coverage: 'partial', tasks: 0 })

      db.db.exec(
        `UPDATE removed_orchestration_work_coverage SET recorded_since = '2000-01-01 00:00:00'`
      )
      db.close()
      db = new OrchestrationDb(path)
      expect(readRunRemovedWork(db.db, run.id, {})?.coverage).toBe('complete')

      // An older build that dropped one capture trigger leaves a gap, so coverage restarts now.
      db.db.exec('DROP TRIGGER trg_tasks_record_removed_work')
      db.close()
      db = new OrchestrationDb(path)
      expect(readRunRemovedWork(db.db, run.id, {})?.coverage).toBe('partial')
      expect(
        db.db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'trg_tasks_record_removed_work'")
          .get()
      ).toBeDefined()
    } finally {
      db?.close()
      db = undefined
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('resetMessages preserves active relay cursors while clearing the Run inbox', () => {
    const state = createState()

    db!.resetMessages()

    expect(db!.getTask(state.task.id)).toBeDefined()
    expect(db!.getInbox()).toEqual([])
    expect(db!.getRemoteQuestion('question_1')).toBeDefined()
    expect(
      db!.listFederationRelay({
        dispatchId: state.started.dispatch.id,
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(1)
    // The pointer idempotency row must not survive deletion of its message batch.
    expect(
      db!.getStructuredPointerOperation(`dispatch:${state.started.dispatch.id}`)
    ).toBeUndefined()
  })
})
