import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

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
  it('keeps a Pi pane working until async subagents finish', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    await harness.callHook('agent_start')
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'child-1', status: 'started' })
    await harness.callHook('agent_settled', undefined, { isIdle: () => true })

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])

    harness.emitPiEvent('task:subagent:lifecycle', { id: 'child-1', status: 'completed' })
    await vi.waitFor(() =>
      expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
    )
  })

  it('ignores malformed or unknown Pi subagent lifecycle events', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    harness.emitPiEvent('task:subagent:lifecycle', {})
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'child-1', status: 'paused' })
    await harness.callHook('agent_start')
    await harness.callHook('agent_settled')
    await vi.waitFor(() =>
      expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
    )
  })

  it('keeps one lifecycle subscription across extension reloads', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    harness.reload()
    expect(harness.piEventListenerCount('task:subagent:lifecycle')).toBe(1)
    expect(harness.piEventListenerCount('subagent:async-started')).toBe(1)
    expect(harness.piEventListenerCount('subagent:async-complete')).toBe(1)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'child-1', status: 'started' })
    await vi.waitFor(() => expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start']))
  })

  it('accepts the pi-subagents async lifecycle aliases', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    harness.emitPiEvent('subagent:async-started', { id: 'child-1' })
    await harness.callHook('agent_settled')
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start'])
    harness.emitPiEvent('subagent:async-complete', { id: 'child-1' })
    await vi.waitFor(() =>
      expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
    )
  })

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

function ompSession(id: string, parentSession?: string) {
  return {
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/sessions/${id}.jsonl`,
      getHeader: () => ({ parentSession })
    }
  }
}

describe('OMP subagent settlement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function lifecycle(harness: AgentStatusExtensionHarness, id: string, status: string) {
    harness.emitPiEvent('task:subagent:lifecycle', { id, status })
    await vi.advanceTimersByTimeAsync(0)
  }

  async function hook(harness: AgentStatusExtensionHarness, name: string) {
    await harness.callHook(name)
    await vi.advanceTimersByTimeAsync(0)
  }

  it.each(OMP_RUNTIME_CASES)(
    'settles %s again when a child starts after the run ended',
    async (_name, args) => {
      const harness = createAgentStatusExtensionHarness(args)

      await hook(harness, 'agent_start')
      await hook(harness, 'agent_end')
      await lifecycle(harness, 'wake-1', 'started')
      await lifecycle(harness, 'wake-1', 'completed')

      expect(postedHookNames(harness.fetchMock)).toEqual([
        'agent_start',
        'agent_end',
        'agent_start',
        'agent_end'
      ])
    }
  )

  it.each(OMP_RUNTIME_CASES)(
    'keeps %s working while a child outlives the next run',
    async (_name, args) => {
      const harness = createAgentStatusExtensionHarness(args)

      await hook(harness, 'agent_start')
      await lifecycle(harness, 'helper', 'started')
      await hook(harness, 'agent_end')
      await hook(harness, 'agent_start')
      await hook(harness, 'agent_end')
      expect(postedHookNames(harness.fetchMock)).not.toContain('agent_end')

      await lifecycle(harness, 'helper', 'completed')
      expect(postedHookNames(harness.fetchMock).at(-1)).toBe('agent_end')
    }
  )

  it.each(OMP_RUNTIME_CASES)(
    'keeps %s working while a late child outlives the next run',
    async (_name, args) => {
      const harness = createAgentStatusExtensionHarness(args)

      await hook(harness, 'agent_start')
      await hook(harness, 'agent_end')
      await lifecycle(harness, 'wake-1', 'started')
      await hook(harness, 'agent_start')
      await hook(harness, 'agent_end')
      expect(postedHookNames(harness.fetchMock).at(-1)).not.toBe('agent_end')

      await lifecycle(harness, 'wake-1', 'completed')
      expect(postedHookNames(harness.fetchMock).at(-1)).toBe('agent_end')
    }
  )

  it('does not settle OMP when a child finishes mid-run', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await hook(harness, 'agent_start')
    await lifecycle(harness, 'child-1', 'started')
    await lifecycle(harness, 'child-1', 'completed')

    expect(postedHookNames(harness.fetchMock)).not.toContain('agent_end')
  })

  it('settles a child woken before the resumed root has run a turn', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook('session_start', {}, ompSession('root'))
    await lifecycle(harness, 'revived', 'started')
    await lifecycle(harness, 'revived', 'completed')

    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })

  it("ignores children seen by an OMP task session's copy of the extension", async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook('agent_start', {}, ompSession('child', '/sessions/root.jsonl'))
    await lifecycle(harness, 'grandchild', 'started')
    await lifecycle(harness, 'grandchild', 'completed')

    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('does not settle a reload that lands while the root run is still in flight', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('session_start', {}, ompSession('root'))
    await hook(harness, 'agent_start')
    harness.reload()

    await lifecycle(harness, 'child-1', 'started')
    await lifecycle(harness, 'child-1', 'completed')
    expect(postedHookNames(harness.fetchMock)).not.toContain('agent_end')

    await hook(harness, 'agent_end')
    expect(postedHookNames(harness.fetchMock).at(-1)).toBe('agent_end')
  })

  it('keeps OMP pane ownership across an extension reload', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('session_start', {}, ompSession('root'))
    await hook(harness, 'agent_start')
    await lifecycle(harness, 'child-1', 'started')
    await hook(harness, 'agent_end')
    harness.reload()
    expect(postedHookNames(harness.fetchMock)).not.toContain('agent_end')

    await lifecycle(harness, 'child-1', 'completed')

    expect(postedHookNames(harness.fetchMock).at(-1)).toBe('agent_end')
  })
})
