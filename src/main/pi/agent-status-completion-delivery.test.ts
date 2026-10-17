import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function events(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
}

describe('OMP completion delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['rejection', 'HTTP failure'])(
    'retries a final %s without another turn',
    async (failure) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(0)
      if (failure === 'rejection') {
        harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      } else {
        harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
      }
      await harness.callHook('agent_end')
      await vi.advanceTimersByTimeAsync(251)
      expect(events(harness.fetchMock)).toEqual([
        { hook_event_name: 'agent_start' },
        { hook_event_name: 'agent_end' },
        { hook_event_name: 'agent_end' }
      ])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['before_agent_start', 'agent_start'])(
    'retires a failed completion at %s',
    async (boundary) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      await harness.callHook('agent_end')
      await vi.advanceTimersByTimeAsync(0)
      await harness.callHook(boundary, {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(
        events(harness.fetchMock).filter((event) => JSON.stringify(event).includes('agent_end'))
      ).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

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

  it.each(['scheduled retry', 'in-flight failure', 'in-flight success'] as const)(
    'preserves completion delivery across a session boundary after %s',
    async (delivery) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      let id = 'A'
      const ctx = {
        isIdle: () => true,
        sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
      }
      await harness.callHook('agent_start', {}, ctx)
      await vi.advanceTimersByTimeAsync(0)
      let acknowledge: ((value: { ok: boolean }) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      if (delivery === 'scheduled retry') {
        harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      } else {
        harness.fetchMock.mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              acknowledge = resolve
              fail = reject
            })
        )
      }
      await harness.callHook('agent_end', {}, ctx)
      await vi.advanceTimersByTimeAsync(0)
      id = 'B'
      await harness.callHook('session_switch', { reason: 'new' }, ctx)
      await harness.callHook('agent_start', {}, ctx)
      if (delivery === 'in-flight failure') {
        fail?.(new Error('late failure'))
      } else {
        acknowledge?.({ ok: true })
      }
      await vi.advanceTimersByTimeAsync(5_000)

      const payloads = events(harness.fetchMock)
      const completions = payloads.filter(
        (event) =>
          event &&
          typeof event === 'object' &&
          'hook_event_name' in event &&
          event.hook_event_name === 'agent_end'
      )
      expect(completions).toHaveLength(delivery === 'in-flight success' ? 1 : 2)
      for (const completion of completions) {
        expect(completion).toMatchObject({ session_id: 'A' })
      }
      expect(payloads.at(-1)).toMatchObject({ hook_event_name: 'agent_start', session_id: 'B' })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retries a timed out completion without blocking agent handlers', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(1251)
    expect(events(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_end' },
      { hook_event_name: 'agent_end' }
    ])
    expect(harness.fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds retries when Orca stays unreachable', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.fetchMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
