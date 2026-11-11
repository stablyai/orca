import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  CURRENT_WORKER_HANDLE,
  CURRENT_WORKER_PANE,
  evidence,
  invoke,
  request,
  WORKER_HANDLE,
  WORKER_PANE
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('current orchestration authority precedence', () => {
  it.each([
    ['heartbeat', undefined],
    ['worker_done', 'succeeded']
  ] as const)('routes a current %s before legacy fallback', async (type, outcome) => {
    const harness = createHarness()
    const { taskId, dispatchId } = createCurrentDispatch(harness)
    const payload = JSON.stringify({
      taskId,
      dispatchId,
      ...(outcome ? { outcome } : {})
    })
    const response = await harness.dispatcher.dispatch({
      ...request(
        'orchestration.send',
        {
          from: CURRENT_WORKER_HANDLE,
          subject: type === 'heartbeat' ? 'alive' : 'Completed',
          type,
          payload
        },
        currentEvidence('worker'),
        `current-${type}`
      )
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: {
          from_handle: CURRENT_WORKER_HANDLE,
          to_handle: expect.stringMatching(/^run:/),
          type,
          delivery_contract: 'current_delivery'
        }
      }
    })
    expect(response).not.toHaveProperty('result.legacyCompatibility')
    expect(harness.db.getTask(taskId)?.status).toBe(
      type === 'worker_done' ? 'completed' : 'dispatched'
    )
  })

  it('routes a current worker mailbox check before legacy fallback', async () => {
    const harness = createHarness()
    const { runId, dispatchId } = createCurrentDispatch(harness)
    const message = harness.db.insertMessage({
      runId,
      from: CURRENT_COORDINATOR_HANDLE,
      to: `dispatch:${dispatchId}`,
      subject: 'current guidance',
      deliveryContract: 'current_delivery'
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: CURRENT_WORKER_HANDLE },
        currentEvidence('worker'),
        'current-worker-check'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        runId,
        dispatchId,
        deliveryId: expect.any(String),
        messages: [{ id: message.id }],
        count: 1
      }
    })
    expect(harness.db.getMessageById(message.id)?.read).toBe(1)

    const deliveryId = (response as { result: { deliveryId: string } }).result.deliveryId
    // A response lost in transit replays from the request receipt when retried with the same id.
    const replayed = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: CURRENT_WORKER_HANDLE },
        currentEvidence('worker'),
        'current-worker-check'
      )
    )
    expect(replayed).toMatchObject({
      ok: true,
      result: { deliveryId, messages: [{ id: message.id }], count: 1 }
    })

    const acknowledged = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: CURRENT_WORKER_HANDLE, ack: deliveryId },
        currentEvidence('worker'),
        'current-worker-check-ack'
      )
    )

    expect(acknowledged).toMatchObject({
      ok: true,
      result: { acknowledged: deliveryId, count: 0 }
    })
    expect(harness.db.getMessageById(message.id)?.read).toBe(1)
  })

  it.each(['dispatch', 'websocket'] as const)(
    '%s routes a reused legacy terminal current check before its retained principal',
    async (transport) => {
      const harness = createHarness()
      const { runId, dispatchId } = await createReusedCurrentDispatch(harness, transport)
      const message = harness.db.insertMessage({
        runId,
        from: CURRENT_COORDINATOR_HANDLE,
        to: `dispatch:${dispatchId}`,
        subject: 'reused terminal guidance',
        deliveryContract: 'current_delivery'
      })

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.check',
          { terminal: WORKER_HANDLE },
          evidence('worker'),
          `reused-current-check-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          runId,
          dispatchId,
          messages: [{ id: message.id }],
          count: 1
        }
      })
      expect(response).not.toHaveProperty('result.legacyCompatibility')
    }
  )

  it.each(['dispatch', 'websocket'] as const)(
    '%s routes a reused legacy terminal current ask before its retained principal',
    async (transport) => {
      const harness = createHarness()
      const { dispatchId } = await createReusedCurrentDispatch(harness, transport)

      const response = await invoke(
        harness.dispatcher,
        {
          ...request(
            'orchestration.ask',
            {
              from: WORKER_HANDLE,
              question: 'Continue with the current assignment?',
              timeoutMs: 0
            },
            evidence('worker'),
            `reused-current-ask-${transport}`
          )
        },
        transport
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          answer: null,
          messageId: expect.any(String),
          timedOut: true
        }
      })
      expect(response).not.toHaveProperty('result.legacyCompatibility')
      const questionId = (response as { result: { messageId: string } }).result.messageId
      expect(harness.db.getQuestion(questionId)?.dispatch_id).toBe(dispatchId)
    }
  )
})

function createCurrentDispatch(harness: ReturnType<typeof createHarness>): {
  runId: string
  taskId: string
  dispatchId: string
} {
  const run = harness.db.createRun({
    objective: 'current work',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  })
  const task = harness.db.createTask({ spec: 'current assignment', runId: run.id })
  const dispatch = createRootDispatch(
    harness.db,
    task.id,
    CURRENT_WORKER_HANDLE,
    CURRENT_WORKER_PANE,
    undefined,
    'process-1'
  )
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id }
}

async function createReusedCurrentDispatch(
  harness: ReturnType<typeof createHarness>,
  suffix: string
): Promise<{
  runId: string
  taskId: string
  dispatchId: string
}> {
  const legacyCheck = await harness.dispatcher.dispatch(
    request(
      'orchestration.check',
      { terminal: WORKER_HANDLE, peek: true },
      evidence('worker'),
      `attest-legacy-worker-${suffix}`
    )
  )
  expect(legacyCheck).toHaveProperty('result.legacyCompatibility')
  harness.db.completeDispatch(harness.dispatchId)

  const run = harness.db.createRun({
    objective: 'current work in reused terminal',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  })
  const task = harness.db.createTask({ spec: 'reused terminal assignment', runId: run.id })
  const dispatch = createRootDispatch(
    harness.db,
    task.id,
    WORKER_HANDLE,
    WORKER_PANE,
    undefined,
    'process-1'
  )
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id }
}
