import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function postedHookNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String(call[1]?.body)).payload.hook_event_name as string
  )
}

describe('Pi background subagent status', () => {
  afterEach(() => vi.useRealTimers())

  it('stays working after the parent settles and completes when the final child exits', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    await harness.callHook('agent_settled')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])

    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })

  it('tracks multiple runs and ignores duplicate or malformed lifecycle events', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    harness.emitEvent('subagent:async-started', { id: 'run-2' })
    harness.emitEvent('subagent:async-started', { id: 3 })
    await harness.callHook('agent_settled')

    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    harness.emitEvent('subagent:async-complete', { id: 'run-2' })
    await vi.advanceTimersByTimeAsync(100)
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])

    harness.emitEvent('subagent:async-complete', { runId: 'run-2' })
    harness.emitEvent('subagent:async-complete', { runId: 'run-2' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })

  it('does not publish transient completion when the final child wakes the parent', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    await harness.callHook('agent_settled')
    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    await harness.callHook('before_agent_start', { prompt: 'consume child result' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'before_agent_start'])

    await harness.callHook('agent_start')
    await harness.callHook('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedHookNames(harness.fetchMock)).toEqual([
      'agent_start',
      'before_agent_start',
      'agent_start',
      'agent_end'
    ])
  })

  it('preserves active child state across an in-process extension reload', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    expect(harness.eventListenerCount()).toBe(2)
    await harness.callHook('agent_start')
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    await harness.callHook('agent_settled')
    await harness.callHook('session_shutdown')
    expect(harness.eventListenerCount()).toBe(0)

    harness.reload()
    expect(harness.eventListenerCount()).toBe(2)
    await harness.callHook('session_start', { reason: 'reload' })
    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })

  it('keeps stale process listeners inert when reload has no shutdown callback', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    harness.emitEvent('subagent:async-started', { id: 'run-1' })
    await harness.callHook('agent_settled')
    harness.reload()
    expect(harness.eventListenerCount()).toBe(4)

    await harness.callHook('session_start', { reason: 'reload' })
    harness.emitEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })

  it('preserves normal no-subagent completion behavior', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    await harness.callHook('agent_settled')

    await vi.waitFor(() =>
      expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
    )
  })
})
