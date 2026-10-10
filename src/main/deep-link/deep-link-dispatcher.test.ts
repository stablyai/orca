import { describe, expect, it, vi } from 'vitest'
import type { RuntimeGraphStatus } from '../../shared/runtime-types'
import {
  createDeepLinkDispatcher,
  type DeepLinkDispatcherOptions,
  type FocusableRuntime
} from './deep-link-dispatcher'
import type { OrcaFocusDeepLink } from './orca-deep-link'

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
    focusTerminal: options.focusTerminal ?? vi.fn(async (handle: string) => focusResult(handle)),
    resolveActiveTerminal: options.resolveActiveTerminal ?? vi.fn(async () => 'term_active')
  }
}

function focusResult(handle: string): Awaited<ReturnType<FocusableRuntime['focusTerminal']>> {
  return { handle, tabId: 'tab', worktreeId: 'wt', navigated: false }
}

function focusLink(target: Partial<Omit<OrcaFocusDeepLink, 'kind'>> = {}): OrcaFocusDeepLink {
  return { kind: 'focus', terminal: null, worktree: null, ...target }
}

function makeDispatcher(
  runtime: FocusableRuntime | null,
  overrides: Partial<DeepLinkDispatcherOptions> = {}
) {
  const warn = vi.fn()
  const dispatcher = createDeepLinkDispatcher({
    getRuntime: () => runtime,
    warn,
    delay: async () => {},
    ...overrides
  })
  return { dispatcher, warn }
}

describe('createDeepLinkDispatcher', () => {
  it('focuses the requested terminal handle', async () => {
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const { dispatcher, warn } = makeDispatcher(makeRuntime({ focusTerminal }))

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc' }))

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
    expect(warn).not.toHaveBeenCalled()
  })

  it('resolves the active terminal from a worktree selector', async () => {
    const resolveActiveTerminal = vi.fn(async () => 'term_resolved')
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const { dispatcher } = makeDispatcher(makeRuntime({ resolveActiveTerminal, focusTerminal }))

    await dispatcher.dispatch(focusLink({ worktree: 'id:wt123' }))

    expect(resolveActiveTerminal).toHaveBeenCalledWith('id:wt123')
    expect(focusTerminal).toHaveBeenCalledWith('term_resolved')
  })

  it('prefers an explicit terminal handle over the worktree selector', async () => {
    const resolveActiveTerminal = vi.fn(async () => 'term_resolved')
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const { dispatcher } = makeDispatcher(makeRuntime({ resolveActiveTerminal, focusTerminal }))

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc', worktree: 'id:wt123' }))

    expect(resolveActiveTerminal).not.toHaveBeenCalled()
    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
  })

  it('does nothing beyond activation for a bare focus link', async () => {
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const getRuntime = vi.fn(() => makeRuntime({ focusTerminal }))
    const { dispatcher } = makeDispatcher(null, { getRuntime })

    await dispatcher.dispatch(focusLink())

    expect(getRuntime).not.toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('waits for the renderer graph to become ready before focusing', async () => {
    let clock = 0
    let graphStatus: RuntimeGraphStatus = 'reloading'
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const runtime: FocusableRuntime = {
      getStatus: () => ({ graphStatus }) as ReturnType<FocusableRuntime['getStatus']>,
      focusTerminal,
      resolveActiveTerminal: vi.fn(async () => 'term_active')
    }
    const { dispatcher } = makeDispatcher(runtime, {
      now: () => clock,
      // Advance the clock and flip to ready on the third poll.
      delay: async () => {
        clock += 150
        if (clock >= 300) {
          graphStatus = 'ready'
        }
      }
    })

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc' }))

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
  })

  it('waits for a runtime that does not exist yet at dispatch time', async () => {
    // A second-instance link can land while the first launch is still constructing the runtime.
    let runtime: FocusableRuntime | null = null
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    let clock = 0
    const { dispatcher } = makeDispatcher(null, {
      getRuntime: () => runtime,
      now: () => clock,
      delay: async () => {
        clock += 150
        if (clock >= 450) {
          runtime = makeRuntime({ focusTerminal })
        }
      }
    })

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc' }))

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
  })

  it('holds a cold-start focus intent until a slow boot reports the graph ready', async () => {
    // A real cold boot can take tens of seconds, so the queued focus must survive
    // until the graph is ready rather than being dropped mid-boot.
    let clock = 0
    let graphStatus: RuntimeGraphStatus = 'unavailable'
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const runtime: FocusableRuntime = {
      getStatus: () => ({ graphStatus }) as ReturnType<FocusableRuntime['getStatus']>,
      focusTerminal,
      resolveActiveTerminal: vi.fn(async () => 'term_active')
    }
    const { dispatcher, warn } = makeDispatcher(runtime, {
      now: () => clock,
      // Boot completes at 30s, inside the 60s budget.
      delay: async () => {
        clock += 150
        if (clock >= 30_000) {
          graphStatus = 'ready'
        }
      }
    })

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc' }))

    expect(focusTerminal).toHaveBeenCalledWith('term_abc')
    expect(warn).not.toHaveBeenCalled()
  })

  it('gives up gracefully when the graph never becomes ready', async () => {
    let clock = 0
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const { dispatcher, warn } = makeDispatcher(
      makeRuntime({ graphStatus: 'unavailable', focusTerminal }),
      {
        now: () => clock,
        graphReadyTimeoutMs: 500,
        delay: async () => {
          clock += 150
        }
      }
    )

    await dispatcher.dispatch(focusLink({ terminal: 'term_abc' }))

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not throw when focusing an unknown or exited terminal', async () => {
    const focusTerminal = vi.fn(async () => {
      throw new Error('terminal_exited')
    })
    const { dispatcher, warn } = makeDispatcher(makeRuntime({ focusTerminal }))

    await expect(dispatcher.dispatch(focusLink({ terminal: 'term_gone' }))).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not throw when a worktree has no active terminal', async () => {
    const resolveActiveTerminal = vi.fn(async () => {
      throw new Error('no_active_terminal')
    })
    const focusTerminal = vi.fn(async (handle: string) => focusResult(handle))
    const { dispatcher, warn } = makeDispatcher(
      makeRuntime({ resolveActiveTerminal, focusTerminal })
    )

    await expect(
      dispatcher.dispatch(focusLink({ worktree: 'branch:gone' }))
    ).resolves.toBeUndefined()

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
