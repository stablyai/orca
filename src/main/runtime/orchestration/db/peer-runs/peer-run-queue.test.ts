import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { generateId } from '../generated-id'
import {
  RemoteOwnedWorkerMail,
  RemoteOwnedWorkerState
} from '../../../../../shared/orchestration/remote-owned-wire'
import { AGENT_PROMPT_STALLED_ERROR } from '../../../terminal/input/agent-prompt-submission-verification'
import type { PeerRunRow } from './peer-run-store'

describe("a paired Orca's Run: its queue home", () => {
  let db: OrchestrationDb
  let peerRun: PeerRunRow

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    peerRun = db.admitPeerRun({
      peerFingerprint: 'fingerprint_a',
      peerRun: { runId: 'run_home', conversationId: generateId('peerconv'), label: 'devA' }
    })
  })

  afterEach(() => db.close())

  function start(params: { adoptTaskId?: string; retryOf?: string } = {}) {
    return db.createStartingWorkerDispatch({
      taskSpec: 'Build it',
      taskRunId: peerRun.run_id,
      startOptions: { agent: 'claude' },
      creator: { kind: 'system' },
      maxDepth: 5,
      ...params
    })
  }

  function pending() {
    return db.listPendingFederationRelay(peerRun.conversation_id, 'to_home', 500)
  }

  function states() {
    return pending()
      .filter((item) => item.kind === 'worker_state')
      .map((item) => RemoteOwnedWorkerState.parse(JSON.parse(item.payload)))
  }

  function fail(dispatchId: string, taskId: string) {
    db.transitionLifecycle({ entity: 'worker', id: dispatchId, from: 'starting', to: 'failed' })
    db.transitionLifecycle({ entity: 'dispatch', id: dispatchId, from: 'pending', to: 'failed' })
    db.transitionLifecycle({ entity: 'task', id: taskId, from: 'dispatched', to: 'failed' })
  }

  it('queues every lifecycle change of a Dispatch and its Task, in order, as the wire schema', () => {
    const { dispatch, task } = start({ adoptTaskId: 'task_home1' })
    fail(dispatch.id, task.id)

    expect(task.id).toBe('task_home1')
    const items = pending()
    expect(items.map((item) => item.sequence)).toEqual(items.map((_, index) => index + 1))
    expect(
      states().map((state) => [
        state.dispatch.status,
        state.dispatch.workerState,
        state.task.status
      ])
    ).toEqual([
      ['pending', null, 'ready'],
      ['pending', 'starting', 'dispatched'],
      ['pending', 'failed', 'dispatched'],
      ['failed', 'failed', 'dispatched'],
      ['failed', 'failed', 'failed']
    ])
    expect(states().every((state) => state.homeRunId === 'run_home')).toBe(true)
    for (const item of items) {
      expect(JSON.parse(item.payload).id).toBe(item.message_id)
    }
  })

  it("queues the report owner's unobserved-prompt correction once, flagged, with its result", () => {
    const { dispatch, task } = start()
    fail(dispatch.id, task.id)
    db.transitionLifecycle({
      entity: 'dispatch',
      id: dispatch.id,
      from: 'failed',
      to: 'failed',
      projection: { last_failure: AGENT_PROMPT_STALLED_ERROR }
    })
    const before = states().length

    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded',
      result: 'actually done'
    })

    expect(states().slice(before)).toEqual([
      expect.objectContaining({
        correctedUnobservedPrompt: true,
        dispatch: expect.objectContaining({ status: 'completed', workerState: 'succeeded' }),
        task: { status: 'completed', result: 'actually done' }
      })
    ])
  })

  it('holds back the Task change of a correction even when a newer attempt is the latest', () => {
    const first = start()
    fail(first.dispatch.id, first.task.id)
    db.transitionLifecycle({
      entity: 'dispatch',
      id: first.dispatch.id,
      from: 'failed',
      to: 'failed',
      projection: { last_failure: AGENT_PROMPT_STALLED_ERROR }
    })
    const retry = start({ adoptTaskId: first.task.id })
    fail(retry.dispatch.id, first.task.id)
    const before = states().length

    db.settleWorkerReport({
      taskId: first.task.id,
      dispatchId: first.dispatch.id,
      outcome: 'succeeded',
      result: 'actually done'
    })

    expect(states().slice(before)).toEqual([
      expect.objectContaining({
        correctedUnobservedPrompt: true,
        dispatch: expect.objectContaining({ id: first.dispatch.id })
      })
    ])
  })

  it("queues a worker's question with its thread, so the coordinator can answer in it", () => {
    const { dispatch } = start()
    const { message } = db.createQuestion({
      runId: peerRun.run_id,
      dispatchId: dispatch.id,
      askerHandle: 'term_w',
      question: 'Which branch?'
    })
    const queued = pending().find((item) => item.message_id === message.id)!
    expect(RemoteOwnedWorkerMail.parse(JSON.parse(queued.payload)).message.threadId).toBe(
      message.id
    )
  })

  it('never reuses a sequence after a reset, and a reset tells the coordinator what it removed', () => {
    const first = start()
    const throughOld = Math.max(...pending().map((item) => item.sequence))

    db.resetTasks()
    const removed = states().filter((state) => state.removed)
    expect(removed.map((state) => [state.dispatch.id, state.removed?.reason])).toEqual([
      [first.dispatch.id, 'reset on the server running it']
    ])
    start()
    db.acknowledgeFederationRelay({
      dispatchId: peerRun.conversation_id,
      direction: 'to_home',
      throughSequence: throughOld
    })

    const after = pending()
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((item) => item.sequence > throughOld)).toBe(true)
  })

  it('keeps the queue and the Run ID through a full reset, with a removed item per Dispatch', () => {
    const { dispatch } = start()
    db.resetAll()

    expect(states().find((state) => state.removed)?.dispatch.id).toBe(dispatch.id)
    const again = db.admitPeerRun({
      peerFingerprint: 'fingerprint_a',
      peerRun: { runId: 'run_home', conversationId: peerRun.conversation_id, label: 'devA' }
    })
    expect(again.run_id).toBe(peerRun.run_id)
    expect(db.getRun(peerRun.run_id)).toBeDefined()
  })

  it('attributes mail rerouted into the Run to the Dispatch its sender worked for when it sent it', () => {
    const coordinator = `peer:${peerRun.conversation_id}`
    const first = start()
    const note = db.insertMessage({
      from: 'term_w',
      to: 'term_unbound',
      subject: 'late note',
      runId: peerRun.run_id,
      senderDispatchId: first.dispatch.id
    })
    fail(first.dispatch.id, first.task.id)
    start()
    db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(coordinator, note.id)
    db.db
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(`run:${peerRun.run_id}`, note.id)

    const mail = pending()
      .filter((item) => item.kind === 'worker_mail')
      .map((item) => RemoteOwnedWorkerMail.parse(JSON.parse(item.payload)))
    expect(mail.map((item) => [item.id, item.dispatchId, item.taskId])).toEqual([
      [note.id, first.dispatch.id, first.task.id]
    ])
  })

  it('reopens an adopted Task whose last attempt settled, so the coordinator can run it again', () => {
    const first = start({ adoptTaskId: 'task_home1' })
    fail(first.dispatch.id, first.task.id)

    const again = start({ adoptTaskId: 'task_home1' })
    expect(again.task.id).toBe('task_home1')
    expect(again.dispatch.id).not.toBe(first.dispatch.id)
    expect(() => start({ adoptTaskId: 'task_home1' })).toThrow(/only a ready Task can start/)
  })

  it('keeps a peer Run conversation and a peer-mail conversation apart, so their sequences never collide', () => {
    const mailConversation = generateId('peerconv')
    db.insertPeerMailMessage({
      conversationId: mailConversation,
      peerFingerprint: 'fingerprint_a',
      remoteParty: null,
      message: { id: generateId('msg'), from: 'devA:term_x', to: 'term_w', subject: 'hi' }
    })
    expect(() =>
      db.admitPeerRun({
        peerFingerprint: 'fingerprint_a',
        peerRun: { runId: 'run_home2', conversationId: mailConversation, label: 'devA' }
      })
    ).toThrow(expect.objectContaining({ code: 'request_mismatch' }))
    expect(() =>
      db.insertPeerMailMessage({
        conversationId: peerRun.conversation_id,
        peerFingerprint: 'fingerprint_a',
        remoteParty: null,
        message: { id: generateId('msg'), from: 'devA:term_x', to: 'term_w', subject: 'hi' }
      })
    ).toThrow(expect.objectContaining({ code: 'request_mismatch' }))
  })

  it("follows a rename of the coordinating Orca's machine", () => {
    const renamed = db.admitPeerRun({
      peerFingerprint: 'fingerprint_a',
      peerRun: { runId: 'run_home', conversationId: peerRun.conversation_id, label: 'devA2' }
    })
    expect(renamed.home_label).toBe('devA2')
  })

  it('leaves an adopted Task that still waits on its dependencies waiting', () => {
    const dependency = db.createTask({ spec: 'first', runId: peerRun.run_id })
    const task = db.createTask({
      spec: 'second',
      runId: peerRun.run_id,
      deps: [dependency.id]
    })
    expect(() => start({ adoptTaskId: task.id })).toThrow(/only a ready Task can start/)
    expect(db.getTask(task.id)?.status).toBe('pending')
  })

  it('admits no start into a Run its coordinator cancelled', () => {
    db.closePeerRun(peerRun.run_id)
    expect(() => start()).toThrow(/cancelled by devA/)
  })
})
