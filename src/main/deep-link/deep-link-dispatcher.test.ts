import { describe, expect, it, vi } from 'vitest'
import type { RuntimeGraphStatus } from '../../shared/runtime-types'
import {
  createDeepLinkDispatcher,
  type DeepLinkDispatcherOptions,
  type FocusableRuntime
} from './deep-link-dispatcher'

type RuntimeStubOptions = {
  graphStatus?: RuntimeGraphStatus
  focusTerminal?: FocusableRuntime['focusTerminal']
  resolveActiveTerminal?: FocusableRuntime['resolveActiveTerminal']
}

function makeRuntime(options: RuntimeStubOptions = {}): FocusableRuntime {
  return {
    getStatus: () =>
      ({ graphStatus: options.graphStatus ?? 'ready' }) as ReturnType<
        FocusableRuntime['getStatus']
      >,
    focusTerminal:
      options.focusTerminal ??
      vi.fn(async (handle: string) => ({ handle, tabId: 'tab', worktreeId: 'wt' })),
    resolveActiveTerminal: options.resolveActiveTerminal ?? vi.fn(async () => 'term_active')
  }
}

function makeDispatcher(
  runtime: FocusableRuntime | null,
  overrides: Partial<DeepLinkDispatcherOptions> = {}
) {
  const focusWindow = vi.fn()
  const warn = vi.fn()
  const dispatcher = createDeepLinkDispatcher({
    focusWindow,
    getRuntime: () => runtime,
    warn,
    delay: async () => {},
    ...overrides
  })
  return { dispatcher, focusWindow, warn, runtime }
}

describe('createDeepLinkDispatcher', () => {
  it('focuses the window and the requested terminal handle', async () => {
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ focusTerminal })
    const { dispatcher, focusWindow, warn } = makeDispatcher(runtime)

    await dispatcher.dispatch('orca://focus?terminal=term_abc')

    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
    expect(warn).not.toHaveBeenCalled()
  })

  it('resolves the active terminal from a worktree selector', async () => {
    const resolveActiveTerminal = vi.fn(async () => 'term_resolved')
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ resolveActiveTerminal, focusTerminal })
    const { dispatcher } = makeDispatcher(runtime)

    await dispatcher.dispatch('orca://focus?worktree=id:wt123')

    expect(resolveActiveTerminal).toHaveBeenCalledWith('id:wt123')
    expect(focusTerminal).toHaveBeenCalledWith('term_resolved')
  })

  it('prefers an explicit terminal handle over the worktree selector', async () => {
    const resolveActiveTerminal = vi.fn(async () => 'term_resolved')
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ resolveActiveTerminal, focusTerminal })
    const { dispatcher } = makeDispatcher(runtime)

    await dispatcher.dispatch('orca://focus?terminal=term_abc&worktree=id:wt123')

    expect(resolveActiveTerminal).not.toHaveBeenCalled()
    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
  })

  it('only focuses the window for a bare focus link', async () => {
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ focusTerminal })
    const { dispatcher, focusWindow } = makeDispatcher(runtime)

    await dispatcher.dispatch('orca://focus')

    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('only focuses the window for non-focus routes such as pair', async () => {
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ focusTerminal })
    const { dispatcher, focusWindow } = makeDispatcher(runtime)

    await dispatcher.dispatch('orca://pair?code=abc')

    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('waits for the renderer graph to become ready before focusing', async () => {
    let clock = 0
    const now = () => clock
    let graphStatus: RuntimeGraphStatus = 'reloading'
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime: FocusableRuntime = {
      getStatus: () => ({ graphStatus }) as ReturnType<FocusableRuntime['getStatus']>,
      focusTerminal,
      resolveActiveTerminal: vi.fn(async () => 'term_active')
    }
    const { dispatcher } = makeDispatcher(runtime, {
      now,
      // Advance the clock and flip to ready on the third poll.
      delay: async () => {
        clock += 150
        if (clock >= 300) {
          graphStatus = 'ready'
        }
      }
    })

    await dispatcher.dispatch('orca://focus?terminal=term_abc')

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
  })

  it('buffers a cold-start focus intent until a slow boot reports the graph ready', async () => {
    // Regression: a real cold boot can take tens of seconds, longer than the old
    // 15s budget, so the queued focus must survive until the graph is ready
    // rather than being dropped mid-boot.
    let clock = 0
    let graphStatus: RuntimeGraphStatus = 'unavailable'
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime: FocusableRuntime = {
      getStatus: () => ({ graphStatus }) as ReturnType<FocusableRuntime['getStatus']>,
      focusTerminal,
      resolveActiveTerminal: vi.fn(async () => 'term_active')
    }
    const { dispatcher, warn } = makeDispatcher(runtime, {
      now: () => clock,
      // Boot completes at 30s — past the old 15s timeout, within the 60s budget.
      delay: async () => {
        clock += 150
        if (clock >= 30_000) {
          graphStatus = 'ready'
        }
      }
    })

    await dispatcher.dispatch('orca://focus?terminal=term_abc')

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
    expect(warn).not.toHaveBeenCalled()
  })

  it('surfaces the window before waiting on the graph so boot is never blocked', async () => {
    // The window must come forward immediately; only the terminal reveal defers
    // until the graph is ready. Record the order of side effects to prove it.
    const order: string[] = []
    let clock = 0
    let graphStatus: RuntimeGraphStatus = 'reloading'
    const runtime: FocusableRuntime = {
      getStatus: () => ({ graphStatus }) as ReturnType<FocusableRuntime['getStatus']>,
      focusTerminal: vi.fn(async (handle: string) => {
        order.push('focusTerminal')
        return { handle, tabId: 't', worktreeId: 'w' }
      }),
      resolveActiveTerminal: vi.fn(async () => 'term_active')
    }
    const focusWindow = vi.fn(() => order.push('focusWindow'))
    const dispatcher = createDeepLinkDispatcher({
      focusWindow,
      getRuntime: () => runtime,
      now: () => clock,
      delay: async () => {
        order.push('poll')
        clock += 150
        graphStatus = 'ready'
      }
    })

    await dispatcher.dispatch('orca://focus?terminal=term_abc')

    // Window is surfaced first, before any graph poll; the terminal reveal follows.
    expect(order[0]).toBe('focusWindow')
    expect(order.indexOf('focusWindow')).toBeLessThan(order.indexOf('poll'))
    expect(order).toContain('focusTerminal')
  })

  it('gives up gracefully when the graph never becomes ready', async () => {
    let clock = 0
    const focusTerminal = vi.fn(async (handle: string) => ({ handle, tabId: 't', worktreeId: 'w' }))
    const runtime = makeRuntime({ graphStatus: 'unavailable', focusTerminal })
    const { dispatcher, focusWindow, warn } = makeDispatcher(runtime, {
      now: () => clock,
      graphReadyTimeoutMs: 500,
      delay: async () => {
        clock += 150
      }
    })

    await dispatcher.dispatch('orca://focus?terminal=term_abc')

    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('does not crash when focusing an unknown or exited terminal', async () => {
    const focusTerminal = vi.fn(async () => {
      throw new Error('terminal_exited')
    })
    const runtime = makeRuntime({ focusTerminal })
    const { dispatcher, focusWindow, warn } = makeDispatcher(runtime)

    await expect(dispatcher.dispatch('orca://focus?terminal=term_gone')).resolves.toBeUndefined()

    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('focuses the window even when the URL is malformed', async () => {
    const runtime = makeRuntime()
    const { dispatcher, focusWindow } = makeDispatcher(runtime)

    await dispatcher.dispatch('not a url')

    expect(focusWindow).toHaveBeenCalledTimes(1)
  })
})
