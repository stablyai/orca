import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function postedHookNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String(call[1]?.body)).payload.hook_event_name as string
  )
}

describe('OMP agent_end delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed terminal completion post', async () => {
    vi.useFakeTimers()
    let agentEndAttempts = 0
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: vi.fn(async (_url, init) => {
        const hookName = JSON.parse(String(init?.body)).payload.hook_event_name as string
        if (hookName !== 'agent_end') {
          return { ok: true }
        }
        agentEndAttempts += 1
        return { ok: agentEndAttempts > 1 }
      })
    })

    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    await harness.callHook('agent_end', { willContinue: false })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3))

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end', 'agent_end'])
  })

  it('cancels a pending completion retry when a new run starts', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: vi.fn(async (_url, init) => ({
        ok: JSON.parse(String(init?.body)).payload.hook_event_name !== 'agent_end'
      }))
    })

    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    await harness.callHook('agent_end', { willContinue: false })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))

    await harness.callHook('before_agent_start', { prompt: 'next turn' })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(postedHookNames(harness.fetchMock)).toEqual([
      'agent_start',
      'agent_end',
      'before_agent_start'
    ])
  })

  it('does not retry failed Pi completion posts', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({ ok: false }))
    })

    await harness.callHook('agent_end')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_end'])
  })
})
