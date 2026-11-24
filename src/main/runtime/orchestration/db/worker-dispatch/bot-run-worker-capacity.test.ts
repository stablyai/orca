import { afterEach, beforeEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  recordRemoteStart,
  releaseRemotePlacement,
  reserveRemotePlacement
} from '../remote-owned/remote-placements'
import {
  closeRemoteRunLink,
  getRemoteRunLink,
  openRemoteRunLink
} from '../remote-owned/remote-run-links'

let db: OrchestrationDb

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
})

it('holds a slot for uncertain starts and rolls back a refused dispatch until a worker settles', () => {
  const run = db.createRun({
    objective: 'Bot work',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const start = (spec: string) =>
    db.createStartingWorkerDispatch({
      taskRunId: run.id,
      taskSpec: spec,
      creator: { kind: 'system' },
      maxDepth: 4,
      startOptions: {},
      chatLineage: true,
      mutationReceipt: {
        callerFingerprint: 'test-caller',
        requestId: spec,
        method: 'orchestration.workerStart',
        payloadHash: spec
      }
    })

  const [first, uncertain] = Array.from({ length: 8 }, (_, index) => start(`Task ${index}`))
  db.markWorkerStartUnknown(uncertain.dispatch.id, 'remote_attach_requested', 'Connection lost')

  expect(() => start('Overflow')).toThrow('This Run already has 8 active workers.')
  expect(db.getMutationReceipt('test-caller', 'Overflow')).toBeUndefined()
  expect(db.listTasks({ runId: run.id })).toHaveLength(8)

  db.failWorkerStart(first.dispatch.id, 'terminal_create', 'Launch refused')
  expect(start('Overflow').worker.state).toBe('starting')
})

it('shares the Run budget with paired starts before and after their server confirms placement', () => {
  const { id: runId } = db.createRun({
    objective: 'Work on both hosts',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const link = openRemoteRunLink(db, runId, {
    environmentId: 'env_server',
    name: 'Server',
    peerFingerprint: 'fp_server'
  })
  const startLocal = () =>
    db.createStartingWorkerDispatch({
      taskRunId: runId,
      taskSpec: 'Local work',
      creator: { kind: 'system' },
      maxDepth: 4,
      startOptions: {},
      chatLineage: true
    })
  const place = (taskId: string) =>
    reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey: taskId,
      create: { spec: 'Paired work' },
      enforceBotRunCapacity: true
    })
  for (let index = 0; index < 6; index++) {
    startLocal()
  }
  place('task_000000000001')
  place('task_000000000002')
  expect(() => startLocal()).toThrow('This Run already has 8 active workers.')
  expect(() => place('task_000000000003')).toThrow('This Run already has 8 active workers.')
  expect(db.getTask('task_000000000003')).toBeUndefined()
  expect(place('task_000000000001').placement.state).toBe('reserved')

  recordRemoteStart(db, {
    conversationId: link.conversation_id,
    taskId: 'task_000000000001',
    requestKey: 'task_000000000001',
    dispatchId: 'ctx_000000000001'
  })
  expect(() => startLocal()).toThrow('This Run already has 8 active workers.')
  releaseRemotePlacement(db, 'task_000000000002', 'task_000000000002')
  expect(place('task_000000000003').placement.state).toBe('reserved')
})

it('keeps workers in the same Run budget while a task reset owes their paired server a cancel', () => {
  const { id: runId } = db.createRun({
    objective: 'Reset paired tasks',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const link = openRemoteRunLink(db, runId, {
    environmentId: 'env_server',
    name: 'Server',
    peerFingerprint: 'fp_server'
  })
  for (let index = 1; index <= 8; index++) {
    const key = String(index).padStart(12, '0')
    const taskId = `task_${key}`
    reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey: key,
      create: { spec: 'Paired work' },
      enforceBotRunCapacity: true
    })
    if (index < 8) {
      recordRemoteStart(db, {
        conversationId: link.conversation_id,
        taskId,
        requestKey: key,
        dispatchId: `ctx_${key}`
      })
    }
  }

  const startLocal = () =>
    db.createStartingWorkerDispatch({
      taskRunId: runId,
      taskSpec: 'Work after reset',
      creator: { kind: 'system' },
      maxDepth: 4,
      startOptions: {},
      chatLineage: true
    })
  db.resetTasks()
  expect(db.listTasks({ runId })).toHaveLength(0)
  expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('cancel_owed')
  expect(() => startLocal()).toThrow('This Run already has 8 active workers.')

  closeRemoteRunLink(db, link.conversation_id, 'Cancellation confirmed')
  expect(startLocal().worker.state).toBe('starting')
})
