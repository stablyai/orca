import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTerminalDoubleTapTabEnabled } from '../storage/preferences'
import { useTerminalDoubleTapTab } from './use-terminal-double-tap-tab'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const focusEffectRuntime = vi.hoisted(() => ({
  callback: null as null | (() => undefined | (() => void)),
  cleanup: null as null | (() => void)
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(callback: () => undefined | (() => void)): void {
      focusEffectRuntime.callback = callback
      React.useEffect(() => {
        const cleanup = callback()
        focusEffectRuntime.cleanup = cleanup ?? null
        return () => {
          cleanup?.()
          if (focusEffectRuntime.cleanup === cleanup) {
            focusEffectRuntime.cleanup = null
          }
        }
      }, [callback])
    }
  }
})

vi.mock('../storage/preferences', () => ({
  loadTerminalDoubleTapTabEnabled: vi.fn()
}))

describe('useTerminalDoubleTapTab', () => {
  let renderer: ReactTestRenderer | null = null
  let cancelPendingTap: (() => void) | null = null
  let shouldSendTab: ((handle: string) => boolean) | null = null
  let now = 100

  function Harness({
    activeHandle,
    lifecycleKey = 'host-a:worktree-a:connected'
  }: {
    activeHandle: string | null
    lifecycleKey?: string
  }): null {
    const handlers = useTerminalDoubleTapTab(activeHandle, lifecycleKey)
    cancelPendingTap = handlers.cancelPendingTap
    shouldSendTab = handlers.shouldSendTabForTap
    return null
  }

  async function mount(activeHandle: string | null = 'terminal-a'): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { activeHandle }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(loadTerminalDoubleTapTabEnabled).mockReset().mockResolvedValue(true)
    focusEffectRuntime.callback = null
    focusEffectRuntime.cleanup = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    cancelPendingTap = null
    shouldSendTab = null
    vi.restoreAllMocks()
  })

  it('sequences two taps after the enabled preference loads', async () => {
    await mount()

    expect(shouldSendTab?.('terminal-a')).toBe(false)
    now += 100
    expect(shouldSendTab?.('terminal-a')).toBe(true)
  })

  it('clears a pending tap across an active terminal change', async () => {
    await mount()
    expect(shouldSendTab?.('terminal-a')).toBe(false)

    act(() => renderer?.update(createElement(Harness, { activeHandle: 'terminal-b' })))
    act(() => renderer?.update(createElement(Harness, { activeHandle: 'terminal-a' })))
    now += 100

    expect(shouldSendTab?.('terminal-a')).toBe(false)
  })

  it('clears a pending tap across route or connection lifecycle changes', async () => {
    await mount()
    expect(shouldSendTab?.('terminal-a')).toBe(false)

    act(() =>
      renderer?.update(
        createElement(Harness, {
          activeHandle: 'terminal-a',
          lifecycleKey: 'host-a:worktree-a:reconnecting'
        })
      )
    )
    now += 100

    expect(shouldSendTab?.('terminal-a')).toBe(false)
  })

  it('clears a pending tap when an excluded terminal gesture occurs', async () => {
    await mount()
    expect(shouldSendTab?.('terminal-a')).toBe(false)

    act(() => cancelPendingTap?.())
    now += 100

    expect(shouldSendTab?.('terminal-a')).toBe(false)
  })

  it('clears state on blur and picks up a disabled preference on refocus', async () => {
    await mount()
    expect(shouldSendTab?.('terminal-a')).toBe(false)

    act(() => {
      focusEffectRuntime.cleanup?.()
      focusEffectRuntime.cleanup = null
    })
    now += 100
    expect(shouldSendTab?.('terminal-a')).toBe(false)

    vi.mocked(loadTerminalDoubleTapTabEnabled).mockResolvedValueOnce(false)
    await act(async () => {
      const cleanup = focusEffectRuntime.callback?.()
      focusEffectRuntime.cleanup = cleanup ?? null
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shouldSendTab?.('terminal-a')).toBe(false)
    now += 100
    expect(shouldSendTab?.('terminal-a')).toBe(false)
    expect(loadTerminalDoubleTapTabEnabled).toHaveBeenCalledTimes(2)
  })

  it('ignores a preference load that resolves after blur', async () => {
    const pendingLoad = deferred<boolean>()
    vi.mocked(loadTerminalDoubleTapTabEnabled).mockReturnValue(pendingLoad.promise)
    await mount()

    act(() => {
      focusEffectRuntime.cleanup?.()
      focusEffectRuntime.cleanup = null
    })
    await act(async () => {
      pendingLoad.resolve(true)
      await pendingLoad.promise
      await Promise.resolve()
    })

    expect(shouldSendTab?.('terminal-a')).toBe(false)
    now += 100
    expect(shouldSendTab?.('terminal-a')).toBe(false)
  })
})
