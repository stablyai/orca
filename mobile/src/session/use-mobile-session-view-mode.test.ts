import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadDefaultSessionView,
  readSessionViewOverridesPreference,
  updateSessionViewOverride,
  type MobileSessionView
} from '../storage/session-view-preferences'
import {
  useMobileSessionViewMode,
  type MobileSessionViewModeController
} from './use-mobile-session-view-mode'

const focusEffectRuntime = vi.hoisted(() => ({
  callback: null as null | (() => undefined | (() => void))
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

vi.mock('expo-router', async () => {
  const react = await import('react')
  return {
    // Run the focus callback once on mount, mirroring a focus.
    useFocusEffect: (cb: () => undefined | (() => void)) => {
      focusEffectRuntime.callback = cb
      react.useEffect(() => cb(), [cb])
    }
  }
})

vi.mock('../storage/session-view-preferences', () => ({
  loadDefaultSessionView: vi.fn(),
  readSessionViewOverridesPreference: vi.fn(),
  updateSessionViewOverride: vi.fn()
}))

describe('useMobileSessionViewMode', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileSessionViewModeController | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(loadDefaultSessionView).mockReset().mockResolvedValue('terminal')
    vi.mocked(readSessionViewOverridesPreference)
      .mockReset()
      .mockResolvedValue({ overrides: new Map(), loaded: true })
    vi.mocked(updateSessionViewOverride).mockReset().mockResolvedValue(undefined)
    focusEffectRuntime.callback = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  async function mount(args: {
    defaultView: MobileSessionView
    overrides?: Map<string, MobileSessionView>
  }): Promise<void> {
    vi.mocked(loadDefaultSessionView).mockResolvedValue(args.defaultView)
    vi.mocked(readSessionViewOverridesPreference).mockResolvedValue({
      overrides: args.overrides ?? new Map(),
      loaded: true
    })
    function Harness(): null {
      controller = useMobileSessionViewMode({ hostId: 'h', worktreeId: 'w' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('follows the default when a tab has no override', async () => {
    await mount({ defaultView: 'terminal' })
    expect(controller?.isTabChatView('t1')).toBe(false)

    act(() => renderer?.unmount())
    renderer = null
    await mount({ defaultView: 'chat' })
    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('lets a per-tab override win over the default', async () => {
    await mount({
      defaultView: 'chat',
      overrides: new Map<string, MobileSessionView>([['t1', 'terminal']])
    })
    expect(controller?.isTabChatView('t1')).toBe(false)
    expect(controller?.isTabChatView('t2')).toBe(true)
  })

  it('reloads the default on refocus after Settings changes it', async () => {
    await mount({ defaultView: 'terminal' })
    expect(controller?.isTabChatView('t1')).toBe(false)
    vi.mocked(loadDefaultSessionView).mockResolvedValue('chat')

    await act(async () => {
      focusEffectRuntime.callback?.()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('toggles from the effective view and persists the override', async () => {
    await mount({ defaultView: 'chat' })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })

    expect(updateSessionViewOverride).toHaveBeenLastCalledWith('h', 'w', 't1', 'terminal')
    expect(controller?.isTabChatView('t1')).toBe(false)
    expect(readSessionViewOverridesPreference).toHaveBeenCalledTimes(1)
  })

  it('toggles a terminal-default tab into chat', async () => {
    await mount({ defaultView: 'terminal' })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })

    expect(updateSessionViewOverride).toHaveBeenLastCalledWith('h', 'w', 't1', 'chat')
    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('does not expose overrides from the previous host while the next scope loads', async () => {
    const nextScopeLoad = deferred<Map<string, MobileSessionView>>()
    vi.mocked(readSessionViewOverridesPreference).mockImplementation((hostId) =>
      hostId === 'h1'
        ? Promise.resolve({
            overrides: new Map([['same-tab-id', 'chat' as const]]),
            loaded: true
          })
        : nextScopeLoad.promise.then((overrides) => ({ overrides, loaded: true }))
    )
    function Harness(props: { hostId: string; worktreeId: string }): null {
      controller = useMobileSessionViewMode(props)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { hostId: 'h1', worktreeId: 'w1' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('same-tab-id')).toBe(true)

    await act(async () => {
      renderer?.update(createElement(Harness, { hostId: 'h2', worktreeId: 'w2' }))
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('same-tab-id')).toBe(false)

    await act(async () => {
      nextScopeLoad.resolve(new Map())
      await Promise.resolve()
    })
  })

  it('merges a toggle made during load with the other persisted overrides', async () => {
    const overridesLoad = deferred<Map<string, MobileSessionView>>()
    vi.mocked(readSessionViewOverridesPreference).mockReturnValue(
      overridesLoad.promise.then((overrides) => ({ overrides, loaded: true }))
    )
    function Harness(): null {
      controller = useMobileSessionViewMode({ hostId: 'h', worktreeId: 'w' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })

    act(() => controller?.toggleTabChatView('new-tab'))
    expect(controller?.isTabChatView('new-tab')).toBe(true)
    expect(updateSessionViewOverride).toHaveBeenCalledWith('h', 'w', 'new-tab', 'chat')

    await act(async () => {
      overridesLoad.resolve(new Map([['saved-tab', 'chat']]))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('saved-tab')).toBe(true)
    expect(controller?.isTabChatView('new-tab')).toBe(true)
  })

  it('toggles from the fail-closed view while overrides load under a chat default', async () => {
    const overridesLoad = deferred<Map<string, MobileSessionView>>()
    vi.mocked(loadDefaultSessionView).mockResolvedValue('chat')
    vi.mocked(readSessionViewOverridesPreference).mockReturnValue(
      overridesLoad.promise.then((overrides) => ({ overrides, loaded: true }))
    )
    function Harness(): null {
      controller = useMobileSessionViewMode({ hostId: 'h', worktreeId: 'w' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('new-tab')).toBe(false)
    act(() => controller?.toggleTabChatView('new-tab'))

    expect(updateSessionViewOverride).toHaveBeenCalledWith('h', 'w', 'new-tab', 'chat')
    expect(controller?.isTabChatView('new-tab')).toBe(true)

    await act(async () => {
      overridesLoad.resolve(new Map())
      await overridesLoad.promise
      await Promise.resolve()
    })
  })

  it('submits rapid mutations in event order', async () => {
    await mount({ defaultView: 'terminal' })
    act(() => controller?.toggleTabChatView('t1'))
    act(() => controller?.toggleTabChatView('t2'))

    expect(updateSessionViewOverride).toHaveBeenNthCalledWith(1, 'h', 'w', 't1', 'chat')
    expect(updateSessionViewOverride).toHaveBeenNthCalledWith(2, 'h', 'w', 't2', 'chat')
  })

  it('reconciles the latest optimistic override when persistence fails', async () => {
    vi.mocked(updateSessionViewOverride).mockRejectedValue(new Error('storage unavailable'))
    vi.mocked(readSessionViewOverridesPreference)
      .mockResolvedValueOnce({
        overrides: new Map<string, MobileSessionView>([['t1', 'terminal']]),
        loaded: true
      })
      .mockResolvedValueOnce({
        overrides: new Map<string, MobileSessionView>([['t1', 'terminal']]),
        loaded: true
      })
    await mount({
      defaultView: 'terminal',
      overrides: new Map<string, MobileSessionView>([['t1', 'terminal']])
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(false)
    expect(readSessionViewOverridesPreference).toHaveBeenCalledTimes(2)
  })

  it('does not let an older failed override roll back a newer choice', async () => {
    const recoveryLoad = deferred<Map<string, MobileSessionView>>()
    vi.mocked(updateSessionViewOverride)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    await mount({ defaultView: 'terminal' })
    vi.mocked(readSessionViewOverridesPreference).mockReturnValueOnce(
      recoveryLoad.promise.then((overrides) => ({ overrides, loaded: true }))
    )

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    act(() => controller?.toggleTabChatView('t1'))

    await act(async () => {
      recoveryLoad.resolve(new Map([['t1', 'chat']]))
      await recoveryLoad.promise
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(false)
    expect(updateSessionViewOverride).toHaveBeenNthCalledWith(2, 'h', 'w', 't1', 'terminal')
  })

  it('fails closed when both an override write and its recovery read fail', async () => {
    vi.mocked(loadDefaultSessionView).mockResolvedValue('chat')
    vi.mocked(updateSessionViewOverride).mockRejectedValue(new Error('storage unavailable'))
    vi.mocked(readSessionViewOverridesPreference)
      .mockResolvedValueOnce({
        overrides: new Map<string, MobileSessionView>([['t1', 'terminal']]),
        loaded: true
      })
      .mockResolvedValueOnce({ overrides: new Map(), loaded: false })
    await mount({
      defaultView: 'chat',
      overrides: new Map<string, MobileSessionView>([['t1', 'terminal']])
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(false)
    expect(readSessionViewOverridesPreference).toHaveBeenCalledTimes(2)
  })

  it('finishes an early toggle save after the route unmounts', async () => {
    const overridesLoad = deferred<Map<string, MobileSessionView>>()
    vi.mocked(readSessionViewOverridesPreference).mockReturnValue(
      overridesLoad.promise.then((overrides) => ({ overrides, loaded: true }))
    )
    function Harness(): null {
      controller = useMobileSessionViewMode({ hostId: 'h', worktreeId: 'w' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
    act(() => controller?.toggleTabChatView('new-tab'))
    act(() => renderer?.unmount())
    renderer = null

    await act(async () => {
      overridesLoad.resolve(new Map([['saved-tab', 'terminal']]))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(updateSessionViewOverride).toHaveBeenCalledWith('h', 'w', 'new-tab', 'chat')
  })

  it('does not reload a failed override after the route unmounts', async () => {
    const failedWrite = deferred<void>()
    vi.mocked(updateSessionViewOverride).mockReturnValue(failedWrite.promise)
    await mount({ defaultView: 'terminal' })

    act(() => controller?.toggleTabChatView('t1'))
    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      failedWrite.reject(new Error('storage unavailable'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(readSessionViewOverridesPreference).toHaveBeenCalledTimes(1)
  })

  it('fails closed to terminal when overrides cannot be read under a chat default', async () => {
    vi.mocked(loadDefaultSessionView).mockResolvedValue('chat')
    vi.mocked(readSessionViewOverridesPreference).mockResolvedValue({
      overrides: new Map(),
      loaded: false
    })

    function Harness(): null {
      controller = useMobileSessionViewMode({ hostId: 'h', worktreeId: 'w' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(false)
  })
})
