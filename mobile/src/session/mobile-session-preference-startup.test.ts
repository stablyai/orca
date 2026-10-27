import AsyncStorage from '@react-native-async-storage/async-storage'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

const focusEffects = vi.hoisted(() => ({
  callbacks: new Map<() => void | (() => void), void | (() => void)>(),
  appStateListeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      focusEffects.appStateListeners.add(listener)
      return { remove: () => focusEffects.appStateListeners.delete(listener) }
    }
  },
  Platform: { OS: 'ios' }
}))
vi.mock('expo-router', async () => {
  const react = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      react.useEffect(() => {
        focusEffects.callbacks.set(effect, effect())
        return () => {
          focusEffects.callbacks.get(effect)?.()
          focusEffects.callbacks.delete(effect)
        }
      }, [effect])
    }
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn() }
}))
vi.mock('../transport/host-store', () => ({ loadHosts: vi.fn().mockResolvedValue([]) }))
vi.mock('../terminal/terminal-foreground-recovery', () => ({
  recoverActiveTerminalAfterForeground: vi.fn(),
  shouldRecoverTerminalOnAppStateChange: () => false
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function sessionScope() {
  return {
    hostId: 'host',
    connState: 'connecting',
    setTerminalTextScale: vi.fn(),
    terminalTextScaleRevisionRef: { current: 0 },
    setAutocompleteEnabled: vi.fn(),
    setTerminalLinkOpenMode: vi.fn(),
    setCustomKeys: vi.fn(),
    setVisibleBuiltInIds: vi.fn(),
    setHostEndpoint: vi.fn(),
    connStateRef: { current: 'connecting' },
    terminalRefs: { current: new Map() },
    initializedHandlesRef: { current: new Set() },
    activeHandleRef: { current: null },
    scheduleDelayedAction: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn()
  }
}

let renderer: ReactTestRenderer | null = null
beforeEach(() => {
  focusEffects.callbacks.clear()
  focusEffects.appStateListeners.clear()
  vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.useRealTimers()
})

describe('saved session settings before the first render', () => {
  it('waits for all terminal reads and keeps readiness while Settings changes apply in place', async () => {
    const scale = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
      if (key === 'orca:terminalTextScale') {
        return scale.promise
      }
      if (key === 'orca:terminalAutocompleteEnabled') {
        return 'true'
      }
      if (key === 'orca:terminalLinkOpenMode') {
        return 'phone-browser'
      }
      return null
    })
    const scope = sessionScope()
    let ready = false
    function Harness() {
      ready = useMobileSessionPreferenceFocus(scope).terminalPreferencesReady
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(false)
    expect(scope.setAutocompleteEnabled).not.toHaveBeenCalled()
    await act(async () => scale.resolve('1.25'))
    expect(ready).toBe(true)
    expect(scope.setTerminalTextScale).toHaveBeenLastCalledWith(1.25)
    expect(scope.setAutocompleteEnabled).toHaveBeenLastCalledWith(true)
    expect(scope.setTerminalLinkOpenMode).toHaveBeenLastCalledWith('phone-browser')

    const nextScale = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:terminalTextScale' ? nextScale.promise : Promise.resolve(null)
    )
    act(() => {
      for (const [effect, cleanup] of focusEffects.callbacks) {
        cleanup?.()
        focusEffects.callbacks.set(effect, effect())
      }
    })
    expect(ready).toBe(true)
    await act(async () => nextScale.resolve('1.5'))
    expect(ready).toBe(true)
    expect(scope.setTerminalTextScale).toHaveBeenLastCalledWith(1.5)
  })

  it('waits for custom keys and built-in layout before publishing accessory readiness', async () => {
    const keys = deferred<string | null>()
    const layout = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:custom-accessory-keys' ? keys.promise : layout.promise
    )
    const scope = sessionScope()
    let ready = false
    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      ready = useMobileSessionLifecycle(scope as never).accessoryPreferencesReady
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(false)
    await act(async () => {
      layout.resolve(
        JSON.stringify({
          version: 2,
          orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
          visibleBuiltInIds: ['tab']
        })
      )
    })
    expect(scope.setVisibleBuiltInIds).toHaveBeenCalledWith(['tab'])
    expect(ready).toBe(false)
    const saved = [{ id: 'k1', label: 'ls', bytes: 'ls', enter: true }]
    await act(async () => keys.resolve(JSON.stringify(saved)))
    expect(scope.setCustomKeys).toHaveBeenCalledWith(saved)
    expect(ready).toBe(true)
  })

  it('keeps a live zoom edit when an older Settings-return read completes', async () => {
    const scope = sessionScope()
    function Harness() {
      useMobileSessionPreferenceFocus(scope)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    scope.setTerminalTextScale.mockClear()
    const scale = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:terminalTextScale' ? scale.promise : Promise.resolve(null)
    )
    act(() => {
      for (const [effect, cleanup] of focusEffects.callbacks) {
        cleanup?.()
        focusEffects.callbacks.set(effect, effect())
      }
    })
    scope.terminalTextScaleRevisionRef.current += 1
    scope.setTerminalTextScale(1.75)
    await act(async () => scale.resolve('1.25'))
    expect(scope.setTerminalTextScale).toHaveBeenCalledTimes(1)
    expect(scope.setTerminalTextScale).toHaveBeenLastCalledWith(1.75)
    expect(scope.setAutocompleteEnabled).toHaveBeenCalledWith(false)
  })

  it('lets the latest foreground layout read settle startup and ignores an older focus read', async () => {
    const older = deferred<string | null>()
    const newer = deferred<string | null>()
    let reads = 0
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) => {
      if (key === 'orca:terminal-accessory-layout') {
        return ++reads === 1 ? older.promise : newer.promise
      }
      return Promise.resolve(null)
    })
    const scope = sessionScope()
    let ready = false
    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      ready = useMobileSessionLifecycle(scope as never).accessoryPreferencesReady
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    act(() => {
      for (const listener of focusEffects.appStateListeners) {
        listener('active')
      }
    })
    const layout = (visibleBuiltInIds: string[]) =>
      JSON.stringify({
        version: 2,
        orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
        visibleBuiltInIds
      })
    await act(async () => newer.resolve(layout(['tab'])))
    expect(ready).toBe(true)
    expect(scope.setVisibleBuiltInIds).toHaveBeenLastCalledWith(['tab'])
    await act(async () => older.resolve(layout(['escape'])))
    expect(scope.setVisibleBuiltInIds).toHaveBeenCalledTimes(1)
    expect(scope.setVisibleBuiltInIds).toHaveBeenLastCalledWith(['tab'])
  })

  it('opens safely after stalled storage and ignores its late results', async () => {
    vi.useFakeTimers()
    const stalled = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockReturnValue(stalled.promise)
    const scope = sessionScope()
    let ready = false
    let chat = true
    function Harness() {
      const terminal = useMobileSessionPreferenceFocus(scope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      const accessory = useMobileSessionLifecycle(scope as never)
      const view = useMobileSessionViewMode({ hostId: 'host', worktreeId: 'folder:/tmp/project' })
      ready = terminal.terminalPreferencesReady && accessory.accessoryPreferencesReady && view.ready
      chat = view.isTabChatView('tab')
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999)
    })
    expect(ready).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(ready).toBe(true)
    expect(chat).toBe(false)
    await act(async () => stalled.resolve('1.5'))
    expect(scope.setTerminalTextScale).not.toHaveBeenCalled()
    expect(scope.setCustomKeys).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores reads from a blurred focus and all reads after unmount', async () => {
    const older = deferred<string | null>()
    const current = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockReturnValue(older.promise)
    const scope = sessionScope()
    function Harness() {
      useMobileSessionPreferenceFocus(scope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      useMobileSessionLifecycle(scope as never)
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    vi.mocked(AsyncStorage.getItem).mockReturnValue(current.promise)
    act(() => {
      for (const [effect, cleanup] of focusEffects.callbacks) {
        cleanup?.()
        focusEffects.callbacks.set(effect, effect())
      }
    })
    await act(async () => older.resolve('1.25'))
    expect(scope.setTerminalTextScale).not.toHaveBeenCalled()
    expect(scope.setVisibleBuiltInIds).not.toHaveBeenCalled()
    act(() => {
      renderer?.unmount()
      renderer = null
    })
    await act(async () => current.resolve('1.5'))
    expect(scope.setTerminalTextScale).not.toHaveBeenCalled()
    expect(scope.setVisibleBuiltInIds).not.toHaveBeenCalled()
  })

  it('finishes startup with safe defaults when real preference loaders encounter failed storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))
    const scope = sessionScope()
    let ready = false
    let chat = true
    function Harness() {
      const terminal = useMobileSessionPreferenceFocus(scope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      const accessory = useMobileSessionLifecycle(scope as never)
      const view = useMobileSessionViewMode({ hostId: 'host', worktreeId: 'folder:/tmp/project' })
      ready = terminal.terminalPreferencesReady && accessory.accessoryPreferencesReady && view.ready
      chat = view.isTabChatView('tab')
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(true)
    expect(chat).toBe(false)
    expect(scope.setTerminalTextScale).toHaveBeenCalledWith(1)
    expect(scope.setAutocompleteEnabled).toHaveBeenCalledWith(false)
    expect(scope.setCustomKeys).toHaveBeenCalledWith([])
    expect(scope.setVisibleBuiltInIds).toHaveBeenCalledWith(
      TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
    )
  })
})
