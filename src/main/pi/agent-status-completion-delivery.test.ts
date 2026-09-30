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

  it.each([22, null])('retries failed or timed-out WSL curl (exit %s)', async (curlExitCode) => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      curlExitCode,
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(curlExitCode === null ? 11251 : 251)
    expect(harness.spawnMock).toHaveBeenCalledTimes(2)
    await harness.callHook('session_shutdown')
    await vi.advanceTimersByTimeAsync(12000)
    expect(harness.spawnMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not acknowledge a missing WSL curl bridge', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(251)
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    await harness.callHook('session_shutdown')
  })

  it('waits for WSL curl acknowledgment before draining a newer snapshot', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      curlExitCode: null,
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(0)
    await harness.callHook('agent_start')
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    harness.spawnedChildren[0]?.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    harness.spawnedChildren[1]?.emit('close', 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['before_agent_start', 'agent_start', 'session_shutdown', 'session_switch'])(
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
