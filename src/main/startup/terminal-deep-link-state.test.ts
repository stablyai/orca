import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalFocus } from '../../shared/runtime-types'
import { TerminalDeepLinkState, type TerminalDeepLinkRuntime } from './terminal-deep-link-state'

const HANDLE = 'term_3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b'
const OTHER_HANDLE = 'term_0123456789abcdef0123456789abcdef'
const link = (handle: string): string => `orca://terminal/${handle}`

// Fails the test on any runtime member other than focusTerminal: the link may only focus.
function focusOnlyRuntime(
  focusTerminal: TerminalDeepLinkRuntime['focusTerminal']
): TerminalDeepLinkRuntime {
  return new Proxy({ focusTerminal } satisfies TerminalDeepLinkRuntime, {
    get(target, property) {
      if (property !== 'focusTerminal') {
        throw new Error(`deep link touched runtime.${String(property)}`)
      }
      return target.focusTerminal
    }
  })
}

function focused(handle: string): RuntimeTerminalFocus {
  return { handle, tabId: 'tab-1', worktreeId: 'wt-1', navigated: true }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalDeepLinkState', () => {
  it('queues a cold-start link and focuses it once the window graph is ready', async () => {
    const focusTerminal = vi.fn(async (handle: string) => focused(handle))
    const runtime = focusOnlyRuntime(focusTerminal)
    const state = new TerminalDeepLinkState()

    expect(state.capture(['orca', link(HANDLE)], null)).toBe(true)
    expect(focusTerminal).not.toHaveBeenCalled()

    state.windowGraphReady(runtime)
    await settle()
    state.windowGraphReady(runtime)
    await settle()

    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(focusTerminal).toHaveBeenCalledWith(HANDLE, {
      navigateHost: true,
      requireLivePty: true
    })
  })

  it('focuses a second-instance link immediately when a window is live', async () => {
    const focusTerminal = vi.fn(async (handle: string) => focused(handle))
    const state = new TerminalDeepLinkState()

    expect(state.capture(['orca', link(OTHER_HANDLE)], focusOnlyRuntime(focusTerminal))).toBe(true)
    await settle()

    expect(focusTerminal).toHaveBeenCalledWith(OTHER_HANDLE, {
      navigateHost: true,
      requireLivePty: true
    })
  })

  it.each([
    'orca://terminal/term_bad',
    `orca://terminals/${OTHER_HANDLE}`,
    `orca://terminal/${OTHER_HANDLE}?x=1`,
    'orca://skills/share/share_abc',
    'orca://pair'
  ])('keeps the pending valid link when %s arrives', async (value) => {
    const focusTerminal = vi.fn(async (handle: string) => focused(handle))
    const runtime = focusOnlyRuntime(focusTerminal)
    const state = new TerminalDeepLinkState()
    state.capture(['orca', link(HANDLE)], null)

    expect(state.capture(['orca', value], runtime)).toBe(false)
    expect(focusTerminal).not.toHaveBeenCalled()
    state.windowGraphReady(runtime)
    await settle()

    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(focusTerminal).toHaveBeenCalledWith(HANDLE, expect.anything())
  })

  it.each(['terminal_not_found', 'terminal_exited', 'terminal_handle_stale'])(
    'logs one line and drops the link when focus fails with %s',
    async (code) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const focusTerminal = vi.fn(async () => {
          throw new Error(code)
        })
        const runtime = focusOnlyRuntime(focusTerminal)
        const state = new TerminalDeepLinkState()

        expect(() => state.capture(['orca', link(HANDLE)], runtime)).not.toThrow()
        await settle()
        state.windowGraphReady(runtime)
        await settle()

        expect(focusTerminal).toHaveBeenCalledOnce()
        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0]![0]).toBe(
          `[deep-link] Ignored orca://terminal/${HANDLE}: ${JSON.stringify(code)}`
        )
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    }
  )

  it('retries an unready graph once on the next graph sync, then drops it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const focusTerminal = vi.fn(async () => {
      throw new Error('runtime_unavailable')
    })
    const runtime = focusOnlyRuntime(focusTerminal)
    const state = new TerminalDeepLinkState()

    state.capture(['orca', link(HANDLE)], runtime)
    await settle()
    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()

    state.windowGraphReady(runtime)
    await settle()
    state.windowGraphReady(runtime)
    await settle()

    expect(focusTerminal).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('focuses a newer link that arrived while an older one was in flight', async () => {
    let releaseFirst: (() => void) | undefined
    const focusTerminal = vi.fn((handle: string) =>
      handle === HANDLE
        ? new Promise<RuntimeTerminalFocus>((_resolve, reject) => {
            releaseFirst = () => reject(new Error('runtime_unavailable'))
          })
        : Promise.resolve(focused(handle))
    )
    const runtime = focusOnlyRuntime(focusTerminal)
    const state = new TerminalDeepLinkState()

    state.capture(['orca', link(HANDLE)], runtime)
    state.capture(['orca', link(OTHER_HANDLE)], null)
    releaseFirst!()
    await settle()
    state.windowGraphReady(runtime)
    await settle()

    expect(focusTerminal.mock.calls.map(([handle]) => handle)).toEqual([HANDLE, OTHER_HANDLE])
  })

  it('truncates and escapes the runtime reason in the log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = new TerminalDeepLinkState()
    state.capture(
      ['orca', link(HANDLE)],
      focusOnlyRuntime(async () => {
        throw new Error(`bad\n${'x'.repeat(500)}`)
      })
    )
    await settle()

    const line = String(warn.mock.calls[0]![0])
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(220)
  })
})
