import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { readRunResetLineage } from './db/reset/run-reset-lineage'

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
    const child = db!.createTask({
      runId: state.run.id,
      parentId: state.task.id,
      spec: 'child work',
      createdByTerminalHandle: 'term_worker'
    })
    const childDispatch = db!.createStartingWorkerDispatch({
      taskId: child.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { worktree: 'current' }
    })
    const resource = db!.createWorkerTerminalResourceStatement({
      dispatchId: childDispatch.dispatch.id,
      worktreeId: null,
      terminalHandle: 'term_child',
      paneKey: null,
      processIncarnation: 'process_child',
      ownership: 'owned'
    })
    const remote = db!.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_reset_fixture',
      runId: state.run.id,
      taskId: child.id,
      homePeerFingerprint: 'peer_remote_reset_fixture',
      protocolVersion: 1,
      runtimeEpoch: 'remote_epoch',
      mutationReceipt: {
        callerFingerprint: 'peer_remote_reset_fixture',
        requestId: 'remote_reset_fixture',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_hash'
      }
    })
    const remoteResource = db!.createWorkerTerminalResourceStatement({
      dispatchId: remote.dispatch_id,
      worktreeId: null,
      terminalHandle: 'term_remote',
      paneKey: null,
      processIncarnation: 'remote_process',
      hostScope: 'remote_host',
      ownership: 'owned'
    })

    const result = db!.resetTasks()

    expect(db!.getRun(state.run.id)).toBeDefined()
    expect(db!.getMessageById(state.message.id)).toBeDefined()
    expect(db!.getTask(state.task.id)).toBeUndefined()
    expect(db!.getWorkerDispatch(state.started.dispatch.id)).toBeUndefined()
    expect(db!.getWorkerTerminalResource(resource.id)).toBeUndefined()
    expect(db!.getWorkerTerminalResource(remoteResource.id)).toBeUndefined()
    const lineage = readRunResetLineage(db!, state.run.id)
    expect(lineage).toMatchObject({
      status: 'complete',
      resetCount: 1,
      batches: [
        {
          requestId: result.requestId,
          scope: {
            tasks: {
              total: 2,
              rows: expect.arrayContaining([
                expect.objectContaining({
                  id: child.id,
                  parent_id: state.task.id,
                  created_by_terminal_handle: 'term_worker'
                })
              ])
            },
            dispatches: {
              total: 2,
              rows: expect.arrayContaining([
                expect.objectContaining({ id: childDispatch.dispatch.id, task_id: child.id })
              ])
            },
            resources: {
              total: 2,
              rows: expect.arrayContaining([
                expect.objectContaining({
                  id: resource.id,
                  owner_dispatch_id: childDispatch.dispatch.id
                }),
                expect.objectContaining({
                  id: remoteResource.id,
                  owner_dispatch_id: remote.dispatch_id
                })
              ])
            },
            remoteAttachments: {
              total: 1,
              rows: [expect.objectContaining({ dispatch_id: remote.dispatch_id })]
            }
          }
        }
      ]
    })
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
    // The dispatch its send was keyed to is gone; the pointer operation must not outlive it.
    expect(
      db!.getStructuredPointerOperation(`dispatch:${state.started.dispatch.id}`)
    ).toBeUndefined()
    const later = db!.createTask({ runId: state.run.id, spec: 'later work' })
    db!.resetTasks()
    expect(readRunResetLineage(db!, state.run.id)).toMatchObject({
      status: 'complete',
      resetCount: 2,
      batches: [
        { scope: { tasks: { total: 2 } } },
        { scope: { tasks: { total: 1, rows: [expect.objectContaining({ id: later.id })] } } }
      ]
    })
  })

  it('still resets when the lineage bound is exceeded and marks the record incomplete', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Large reset',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    for (let index = 0; index < 129; index += 1) {
      db.createTask({ runId: run.id, spec: `task ${index}` })
    }

    db.resetTasks()

    expect(db.listTasks()).toEqual([])
    expect(readRunResetLineage(db, run.id)).toMatchObject({
      status: 'incomplete',
      batches: [{ scope: { tasks: { total: 129, rows: expect.any(Array) } } }]
    })
  })

  it('does not claim complete lifetime history for a Run created before the recording boundary', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Older Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    db.db.prepare('DELETE FROM run_reset_lineage WHERE run_id = ?').run(run.id)
    db.createTask({ runId: run.id, spec: 'recent task' })

    db.resetTasks()

    expect(readRunResetLineage(db, run.id)).toMatchObject({
      status: 'incomplete',
      priorHistoryUnknown: true,
      batches: [{ scope: { tasks: { total: 1 } } }]
    })
  })

  it('rolls back the lineage and receipt with a failed deletion', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Atomic reset',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const mutation = {
      callerFingerprint: 'caller',
      requestId: 'reset_request',
      method: 'orchestration.reset',
      payloadHash: 'tasks'
    }
    db.beginMutationReceipt(mutation)
    db.db.exec(`CREATE TRIGGER refuse_reset BEFORE DELETE ON tasks
      BEGIN SELECT RAISE(ABORT, 'refuse'); END;`)

    expect(() => db!.resetTasks(mutation)).toThrow('refuse')

    expect(db.getTask(task.id)).toBeDefined()
    expect(readRunResetLineage(db, run.id)).toMatchObject({ status: 'no_recorded_reset' })
    expect(db.getMutationReceipt('caller', 'reset_request')?.state).toBe('pending')

    db.db.exec('DROP TRIGGER refuse_reset')
    db.resetTasks(mutation)
    expect(db.getMutationReceipt('caller', 'reset_request')).toMatchObject({
      state: 'completed',
      receipt: expect.stringContaining('"requestId":"reset_request"')
    })
    expect(db.getTask(task.id)).toBeUndefined()
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
    // The row is one nudge's idempotency key over messages this scope deletes.
    expect(
      db!.getStructuredPointerOperation(`dispatch:${state.started.dispatch.id}`)
    ).toBeUndefined()
  })
})
