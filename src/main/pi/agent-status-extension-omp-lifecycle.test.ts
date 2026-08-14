import { describe, expect, it, vi } from 'vitest'

import { createHarness, type Harness } from './agent-status-extension-test-harness'

function postedPayloads(harness: Harness): unknown[] {
  return harness.fetchMock.mock.calls.map(([_url, init]) => JSON.parse(String(init?.body)).payload)
}

describe('OMP agent lifecycle reporting', () => {
  it.each([
    ['no willContinue field', { kind: 'omp' as const }, {}],
    ['willContinue false', { kind: 'omp' as const }, { willContinue: false }],
    ['a runtime-routed OMP binary', { kind: 'pi' as const, title: 'omp' }, { willContinue: false }],
    ['no event payload at all', { kind: 'omp' as const }, undefined]
  ])(
    'posts a terminal agent_end for %s while isIdle stays false',
    async (_label, harnessArgs, event) => {
      const harness = createHarness(harnessArgs)

      await harness.callHook('agent_end', event, { isIdle: () => false })

      await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
      expect(postedPayloads(harness)).toEqual([{ hook_event_name: 'agent_end' }])
    }
  )

  it('keeps the pane working while agent_end schedules an automatic continuation', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ kind: 'omp' })

      await harness.callHook('agent_end', { willContinue: true }, { isIdle: () => false })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(harness.fetchMock).not.toHaveBeenCalled()
      // No idle-recheck timer is left armed to settle the pane behind the continuation.
      expect(vi.getTimerCount()).toBe(0)

      await harness.callHook('agent_start')
      await harness.callHook('agent_end', { willContinue: false }, { isIdle: () => false })
      await vi.advanceTimersByTimeAsync(0)
      expect(postedPayloads(harness)).toEqual([
        { hook_event_name: 'agent_start' },
        { hook_event_name: 'agent_end' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards the approval lifecycle so a parked permission prompt is visible', async () => {
    const harness = createHarness({ kind: 'omp' })

    await harness.callHook('tool_approval_requested', {
      toolName: 'bash',
      reason: 'tools.approval.bash: prompt',
      approvalMode: 'prompt'
    })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    await harness.callHook('tool_approval_resolved', { toolName: 'bash', approved: true })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(postedPayloads(harness)).toEqual([
      {
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash',
        reason: 'tools.approval.bash: prompt',
        approval_mode: 'prompt'
      },
      { hook_event_name: 'tool_approval_resolved', tool_name: 'bash', approved: true }
    ])
  })

  it('leaves Pi and Prime runtimes out of the OMP-only approval lifecycle', async () => {
    const pi = createHarness({ kind: 'pi' })
    const prime = createHarness({ kind: 'prime-agent' })

    await pi.callHook('tool_approval_requested', { toolName: 'bash' })

    expect(pi.fetchMock).not.toHaveBeenCalled()
    expect(prime.handlers.tool_approval_requested).toBeUndefined()
  })
})
