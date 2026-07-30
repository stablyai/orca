import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'

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
    db.enqueueFederationRelay({
      dispatchId: started.dispatch.id,
      direction: 'to_home',
      kind: 'question',
      payload: '{}',
      messageId: 'question_1',
      remoteQuestion: true
    })
    return { run, task, started, message }
  }

  it('resetAll clears Runs, worker/federation state, and messages', () => {
    const state = createState()

    db!.resetAll()

    expect(db!.listRuns().runs).toEqual([expect.objectContaining({ id: LEGACY_RUN_ID, legacy: 1 })])
    expect(db!.getTask(state.task.id)).toBeUndefined()
    expect(db!.getWorkerDispatch(state.started.dispatch.id)).toBeUndefined()
    expect(db!.getFederatedDispatch(state.started.dispatch.id)).toBeUndefined()
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
  })
})
