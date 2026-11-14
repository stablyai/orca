import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function events(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
}

describe('OMP completion delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not schedule retries when a pending completion fails after a new start', async () => {
    let rejectDelivery: ((error: Error) => void) | undefined
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelivery = reject
        })
    )
    await harness.callHook('agent_end')
    await harness.callHook('agent_start')
    rejectDelivery?.(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_end' },
      { hook_event_name: 'agent_start' }
    ])
  })
})
