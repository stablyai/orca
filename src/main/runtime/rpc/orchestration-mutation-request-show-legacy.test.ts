import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  createHarness,
  evidence,
  request
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('orchestration.requestShow legacy coordinator recovery', () => {
  it('reads the same receipt namespace as the original compatibility mutation', async () => {
    const harness = createHarness()
    const mutationRequestId = 'legacy-task-create'
    const mutation = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'recoverable legacy task', callerTerminalHandle: COORDINATOR_HANDLE },
        evidence('coordinator'),
        mutationRequestId
      )
    )
    expect(mutation).toMatchObject({ ok: true, result: { mutation: { replayed: false } } })

    const shown = await harness.dispatcher.dispatch(
      request(
        'orchestration.requestShow',
        { request: mutationRequestId },
        evidence('coordinator'),
        'legacy-request-show'
      )
    )

    expect(shown).toMatchObject({
      ok: true,
      result: {
        requestId: mutationRequestId,
        state: 'completed',
        method: 'orchestration.taskCreate'
      }
    })
  })
})
