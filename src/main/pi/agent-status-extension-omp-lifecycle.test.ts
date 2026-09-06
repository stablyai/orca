import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function postedHookNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String(call[1]?.body)).payload.hook_event_name as string
  )
}

const OMP_RUNTIME_CASES = [
  ['configured OMP', { kind: 'omp' as const }],
  ['title-routed OMP', { kind: 'pi' as const, title: 'omp' }],
  ['argv-routed OMP', { kind: 'pi' as const, argv: ['node', '/usr/local/bin/omp'] }]
] as const

describe('OMP agent_end contract', () => {
  it.each(OMP_RUNTIME_CASES)(
    'keeps %s working when agent_end will continue',
    async (_name, args) => {
      vi.useFakeTimers()
      try {
        const harness = createAgentStatusExtensionHarness(args)
        const context = { isIdle: vi.fn(() => true) }

        await harness.callHook('agent_start')
        await harness.callHook('agent_end', { willContinue: true }, context)
        await vi.advanceTimersByTimeAsync(1_000)

        expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])
        expect(context.isIdle).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(OMP_RUNTIME_CASES)(
    'settles a completed %s turn without waiting for ctx.isIdle',
    async (_name, args) => {
      // Why: absent payload and absent flag are both terminal for a version that cannot send one.
      for (const event of [{ willContinue: false }, {}, undefined]) {
        const harness = createAgentStatusExtensionHarness(args)
        const context = { isIdle: vi.fn(() => false) }

        await harness.callHook('agent_start')
        await harness.callHook('agent_end', event, context)

        await vi.waitFor(() =>
          expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
        )
        expect(context.isIdle).not.toHaveBeenCalled()
      }
    }
  )

  it('settles a later terminal OMP agent_end after a continuation', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = { isIdle: vi.fn(() => false) }

    await harness.callHook('agent_start')
    await harness.callHook('agent_end', { willContinue: true }, context)
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])

    await harness.callHook('agent_end', { willContinue: false }, context)
    await vi.waitFor(() =>
      expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
    )
  })

  it('retries a failed terminal completion post', async () => {
    vi.useFakeTimers()
    try {
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

      await vi.waitFor(() =>
        expect(postedHookNames(harness.fetchMock)).toEqual([
          'agent_start',
          'agent_end',
          'agent_end'
        ])
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending completion retry when a new run starts', async () => {
    vi.useFakeTimers()
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not apply the OMP contract to Pi or Prime', async () => {
    vi.useFakeTimers()
    try {
      for (const kind of ['pi', 'prime-agent'] as const) {
        const harness = createAgentStatusExtensionHarness({ kind })
        const context = { isIdle: vi.fn(() => false) }

        await harness.callHook('agent_end', { willContinue: false }, context)
        await vi.advanceTimersByTimeAsync(1_000)

        expect(postedHookNames(harness.fetchMock)).toEqual([])
        expect(context.isIdle).toHaveBeenCalled()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves non-terminal agent_end handling for Pi and Prime', async () => {
    vi.useFakeTimers()
    try {
      for (const kind of ['pi', 'prime-agent'] as const) {
        const harness = createAgentStatusExtensionHarness({ kind })
        const context = { isIdle: vi.fn(() => true) }

        await harness.callHook('agent_end', { willContinue: true }, context)
        await vi.advanceTimersByTimeAsync(1_000)

        expect(postedHookNames(harness.fetchMock)).toEqual([])
        expect(context.isIdle).not.toHaveBeenCalled()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
