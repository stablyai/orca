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
  type MobileSessionTabViewModeBridge,
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
  let rerenderShared: (() => void) | null = null

  beforeEach(() => {
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
    rerenderShared = null
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

  async function mountShared(args: {
    defaultView: MobileSessionView
    overrides?: Map<string, MobileSessionView>
    hostViews: Map<string, MobileSessionView>
    writeHostViewMode: MobileSessionTabViewModeBridge['writeHostViewMode']
    hostViewSource?: object
    hostPublication?: { epoch: string | null; version: number }
    onHostViewModeWriteError?: (error: unknown) => void
  }): Promise<void> {
    vi.mocked(loadDefaultSessionView).mockResolvedValue(args.defaultView)
    vi.mocked(readSessionViewOverridesPreference).mockResolvedValue({
      overrides: args.overrides ?? new Map(),
      loaded: true
    })
    const bridge: MobileSessionTabViewModeBridge = {
      hostViewSource: args.hostViewSource,
      ...(args.hostPublication ? { readHostViewPublication: () => args.hostPublication! } : {}),
      readHostViewMode: (tabId) => args.hostViews.get(tabId),
      writeHostViewMode: args.writeHostViewMode,
      ...(args.onHostViewModeWriteError
        ? { onHostViewModeWriteError: args.onHostViewModeWriteError }
        : {})
    }
    function Harness() {
      controller = useMobileSessionViewMode({
        hostId: 'h',
        worktreeId: 'w',
        sessionTabViewMode: bridge
      })
      return createElement('Probe', {
        testID: 'view-mode-probe',
        dataChat: controller.isTabChatView('t1')
      })
    }
    rerenderShared = () => {
      act(() => renderer?.update(createElement(Harness)))
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('defers to a host that shares the view, and follows a change made elsewhere', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    await mountShared({
      defaultView: 'terminal',
      overrides: new Map<string, MobileSessionView>([['t1', 'chat']]),
      hostViews,
      writeHostViewMode: () => Promise.resolve()
    })

    // The host value wins over this device's own override.
    expect(controller?.isTabChatView('t1')).toBe(false)

    // A peer flips the host value; the local view follows with no local toggle.
    hostViews.set('t1', 'chat')
    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('keeps the local fallback for a tab the shared host carries no value for', async () => {
    await mountShared({
      defaultView: 'chat',
      hostViews: new Map<string, MobileSessionView>(),
      writeHostViewMode: () => Promise.resolve()
    })

    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('flips from the host value and writes the choice back', async () => {
    const writes: Array<[string, MobileSessionView]> = []
    const hostViews = new Map<string, MobileSessionView>([['t1', 'chat']])
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      writeHostViewMode: (tabId, view) => {
        writes.push([tabId, view])
        return Promise.resolve()
      }
    })

    expect(controller?.isTabChatView('t1')).toBe(true)
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })

    expect(writes).toEqual([['t1', 'terminal']])
    expect(updateSessionViewOverride).toHaveBeenLastCalledWith('h', 'w', 't1', 'terminal')
  })

  it('holds the toggled view while the shared host write is still in flight', async () => {
    const hostWrite = deferred<void>()
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      writeHostViewMode: () => hostWrite.promise
    })

    expect(controller?.isTabChatView('t1')).toBe(false)
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    // The host still reports 'terminal'; the pending write must win so the tap is not lost.
    expect(controller?.isTabChatView('t1')).toBe(true)

    await act(async () => {
      hostWrite.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('clears a matching legacy echo without a publication marker', async () => {
    const hostWrite = deferred<void>()
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const hostPublication = { epoch: 'host', version: 10 }
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostPublication,
      writeHostViewMode: () => hostWrite.promise
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    hostWrite.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Legacy hosts do not return a publication marker, so the accepted matching echo settles it.
    hostViews.set('t1', 'chat')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(true)

    hostViews.set('t1', 'terminal')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('clears on the acknowledged publication even when the peer changed the view', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const publication = { epoch: 'host', version: 10 }
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostPublication: publication,
      writeHostViewMode: async () => ({ publicationEpoch: 'host', snapshotVersion: 11 })
    })
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
      await Promise.resolve()
    })
    const renderedChat = () =>
      renderer?.root.find((node) => node.props.testID === 'view-mode-probe').props.dataChat
    expect(renderedChat()).toBe(true)
    publication.version = 11
    hostViews.set('t1', 'terminal')
    rerenderShared?.()
    expect(renderedChat()).toBe(false)
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('waits for the acknowledged publication epoch before clearing', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const publication = { epoch: 'old', version: 10 }
    const write = deferred<{ publicationEpoch: string; snapshotVersion: number }>()
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostPublication: publication,
      writeHostViewMode: async () => write.promise
    })
    act(() => controller?.toggleTabChatView('t1'))
    await act(async () => {
      write.resolve({ publicationEpoch: 'new', snapshotVersion: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(true)
    publication.epoch = 'new'
    publication.version = 1
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('clears when the acknowledged snapshot arrived before the RPC reply', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const publication = { epoch: 'host', version: 10 }
    const write = deferred<{ publicationEpoch: string; snapshotVersion: number }>()
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostPublication: publication,
      writeHostViewMode: async () => write.promise
    })
    act(() => controller?.toggleTabChatView('t1'))
    publication.version = 11
    hostViews.set('t1', 'terminal')
    rerenderShared?.()
    await act(async () => {
      write.resolve({ publicationEpoch: 'host', snapshotVersion: 11 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('keeps legacy matching echo acknowledgement when the host sends no marker', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostViewSource: {},
      writeHostViewMode: async () => undefined
    })
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
      await Promise.resolve()
    })
    hostViews.set('t1', 'chat')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('clears a legacy write when its matching snapshot arrived before the ACK', async () => {
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const write = deferred<void>()
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostViewSource: {},
      writeHostViewMode: async () => write.promise
    })
    act(() => controller?.toggleTabChatView('t1'))
    hostViews.set('t1', 'chat')
    rerenderShared?.()
    await act(async () => {
      write.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(true)
    hostViews.set('t1', 'terminal')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('flips a second tap from the queued view rather than the host echo it outranks', async () => {
    const hostWrite = deferred<void>()
    const writes: Array<[string, MobileSessionView]> = []
    // The host keeps reporting 'terminal' for the whole sequence; both taps happen before either
    // write lands, so only the queued value can tell the second tap where the tab stands.
    await mountShared({
      defaultView: 'terminal',
      hostViews: new Map<string, MobileSessionView>([['t1', 'terminal']]),
      writeHostViewMode: (tabId, view) => {
        writes.push([tabId, view])
        return hostWrite.promise
      }
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(true)

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })

    expect(writes).toEqual([
      ['t1', 'chat'],
      ['t1', 'terminal']
    ])
    expect(controller?.isTabChatView('t1')).toBe(false)

    await act(async () => {
      hostWrite.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('keeps a rapid second toggle through the first host echo until its own write is echoed', async () => {
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    const writes = [firstWrite, secondWrite]
    const hostViews = new Map<string, MobileSessionView>([['t1', 'terminal']])
    const source = {}
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      hostViewSource: source,
      writeHostViewMode: () => writes.shift()!.promise
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    firstWrite.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    // The first write's chat echo must not confirm the second terminal write.
    hostViews.set('t1', 'chat')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(false)

    secondWrite.resolve()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(false)
    hostViews.set('t1', 'terminal')
    rerenderShared?.()
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('reverts the override and reports the failure when the host rejects the write', async () => {
    const hostWrite = deferred<void>()
    const onError = vi.fn()
    // A tab the host carries no value for, so the local override alone decides the view.
    await mountShared({
      defaultView: 'terminal',
      hostViews: new Map<string, MobileSessionView>(),
      writeHostViewMode: () => hostWrite.promise,
      onHostViewModeWriteError: onError
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(true)

    await act(async () => {
      hostWrite.reject(new Error('host refused'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    // The optimistic override is gone, so the default decides the view again.
    expect(controller?.isTabChatView('t1')).toBe(false)
  })

  it('ignores a stale rejection after reconnect and still handles the current source', async () => {
    const source1 = {}
    const source2 = {}
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    const firstError = vi.fn()
    const secondError = vi.fn()
    const hostViews = new Map<string, MobileSessionView>()

    function Harness(props: {
      source: object
      write: (tabId: string, view: MobileSessionView) => Promise<void>
      onError: (error: unknown) => void
    }): null {
      controller = useMobileSessionViewMode({
        hostId: 'h',
        worktreeId: 'w',
        sessionTabViewMode: {
          hostViewSource: props.source,
          readHostViewMode: (tabId) => hostViews.get(tabId),
          writeHostViewMode: props.write,
          onHostViewModeWriteError: props.onError
        }
      })
      return null
    }

    await act(async () => {
      renderer = create(
        createElement(Harness, {
          source: source1,
          write: () => firstWrite.promise,
          onError: firstError
        })
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(true)

    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          source: source2,
          write: () => secondWrite.promise,
          onError: secondError
        })
      )
      await Promise.resolve()
    })

    await act(async () => {
      firstWrite.reject(new Error('stale host refused'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(firstError).not.toHaveBeenCalled()
    expect(controller?.isTabChatView('t1')).toBe(true)

    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })
    expect(controller?.isTabChatView('t1')).toBe(false)

    await act(async () => {
      secondWrite.reject(new Error('current host refused'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(secondError).toHaveBeenCalledWith(expect.any(Error))
    expect(controller?.isTabChatView('t1')).toBe(true)
  })

  it('never writes to a host that does not share the view', async () => {
    const writes: Array<[string, MobileSessionView]> = []
    const hostViews = new Map<string, MobileSessionView>([['t1', 'chat']])
    await mountShared({
      defaultView: 'terminal',
      hostViews,
      writeHostViewMode: null
    })

    // An incapable host's published value is not authoritative: the local default still decides.
    expect(controller?.isTabChatView('t1')).toBe(false)
    await act(async () => {
      controller?.toggleTabChatView('t1')
      await Promise.resolve()
    })

    expect(writes).toEqual([])
    expect(controller?.isTabChatView('t1')).toBe(true)
  })
})
