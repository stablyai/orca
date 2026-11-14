import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  createHarness,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  evidence,
  invoke,
  request,
  WORKER_HANDLE,
  WORKER_PANE
} from './testing/orchestration-legacy-compatibility-dispatcher-test-fixture'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('current orchestration authority precedence', () => {
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
})

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
