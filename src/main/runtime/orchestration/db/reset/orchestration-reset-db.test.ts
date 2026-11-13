import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

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
    db.reserveStructuredMailSend({
      mailbox_handle: `dispatch:${started.dispatch.id}`,
      message_id: message.id,
      session_id: 'session_1',
      operation_id: '1700000000000-00112233445566778899aabbccddeeff',
      minted_at_ms: 1_700_000_000_000
    })
    return { run, task, started, message, localQuestion }
  }

  // A child Task and worker created by a coordinator, plus a remote worker whose terminal outlives it in reset order.

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
    expect(db!.getStructuredMailSends(`dispatch:${state.started.dispatch.id}`)).toHaveLength(1)
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
    // A chat send record outlives its message until the card it names is deleted from the chat.
    expect(db!.getStructuredMailSends(`dispatch:${state.started.dispatch.id}`)).toHaveLength(1)
  })
})
