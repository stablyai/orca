import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  COORDINATOR_PANE,
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
  it.each(['dispatch', 'websocket'] as const)(
    '%s uses an attested current coordinator binding before legacy fallback',
    async (transport) => {
      const harness = createHarness()
      const run = harness.db.createRun({
        objective: 'current work',
        coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
        coordinatorPaneKey: CURRENT_COORDINATOR_PANE
      })

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.taskCreate',
          {
            spec: 'current assignment',
            callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
          },
          currentEvidence('coordinator'),
          `current-task-create-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({
        ok: true,
        result: { task: { run_id: run.id, spec: 'current assignment' } }
      })
      expect(harness.db.listTasks({ runId: harness.adoptedRunId })).toHaveLength(1)
    }
  )

  it('prefers a different current Run even for the retained coordinator terminal', async () => {
    const harness = createHarness()
    const run = harness.db.createRun({
      objective: 'intentional current work',
      coordinatorHandle: COORDINATOR_HANDLE,
      coordinatorPaneKey: COORDINATOR_PANE
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'current assignment', callerTerminalHandle: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'retained-terminal-current-run'
      )
    )

    expect(response).toMatchObject({ ok: true, result: { task: { run_id: run.id } } })
  })

  it('checks a different current Run before retained coordinator mail', async () => {
    const harness = createHarness()
    const run = harness.db.createRun({
      objective: 'intentional current work',
      coordinatorHandle: COORDINATOR_HANDLE,
      coordinatorPaneKey: COORDINATOR_PANE
    })
    const message = harness.db.insertMessage({
      runId: run.id,
      from: CURRENT_WORKER_HANDLE,
      to: `run:${run.id}`,
      subject: 'current completion',
      deliveryContract: 'current_delivery'
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'retained-terminal-current-check'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { runId: run.id, messages: [{ id: message.id }], count: 1 }
    })
    expect(response).not.toHaveProperty('result.legacyCompatibility')
  })

  it('preserves legacy fallback for a retained coordinator without a current binding', async () => {
    const harness = createHarness()
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'legacy follow-up', callerTerminalHandle: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'legacy-task-create'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { task: { run_id: harness.adoptedRunId, spec: 'legacy follow-up' } }
    })
  })

  it.each([
    ['heartbeat', undefined],
    ['worker_done', 'succeeded']
  ] as const)(
    'routes a capability-backed current %s before legacy fallback',
    async (type, outcome) => {
      const harness = createHarness()
      const { taskId, dispatchId, capability } = createCurrentDispatch(harness)
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
        ),
        orchestrationCapability: capability
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
    }
  )

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
        messages: [{ id: message.id }],
        count: 1
      }
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
      const { dispatchId, capability } = await createReusedCurrentDispatch(harness, transport)

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
          ),
          orchestrationCapability: capability
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
  capability: string
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
    CURRENT_WORKER_PANE
  )
  const capability = harness.db.mintDispatchCapability({
    dispatchId: dispatch.id,
    paneKey: CURRENT_WORKER_PANE,
    processIncarnation: 'process-1'
  })
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id, capability }
}

async function createReusedCurrentDispatch(
  harness: ReturnType<typeof createHarness>,
  suffix: string
): Promise<{
  runId: string
  taskId: string
  dispatchId: string
  capability: string
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
  const dispatch = createRootDispatch(harness.db, task.id, WORKER_HANDLE, WORKER_PANE)
  const capability = harness.db.mintDispatchCapability({
    dispatchId: dispatch.id,
    paneKey: WORKER_PANE,
    processIncarnation: 'process-1'
  })
  return { runId: run.id, taskId: task.id, dispatchId: dispatch.id, capability }
}
