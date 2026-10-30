import AsyncStorage from '@react-native-async-storage/async-storage'
import { createElement, useEffect } from 'react'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import pageAsyncStorage, {
  publishPageStorage,
  refreshPageTerminalShortcuts
} from '../mobile-web-shell/bridge/page-async-storage'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import { saveCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

const pageBridge = vi.hoisted((): { client: BridgeRpcClient | null } => ({ client: null }))
vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () => pageBridge.client
}))
vi.mock('../platform/shell-storage', async () => import('../platform/shell-storage.web'))

const focusEffects = vi.hoisted(() => ({
  callbacks: new Map<() => void | (() => void), void | (() => void)>(),
  appStateListeners: new Set<(state: string) => void>()
}))

const shellGeometry = vi.hoisted(() => ({ sideRail: false }))
vi.mock('../layout/use-shell-side-rail', () => ({
  useDirectionPadAvailable: () => shellGeometry.sideRail
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
  default: { getItem: vi.fn(), setItem: vi.fn() }
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

function refocus() {
  act(() => {
    for (const [effect, cleanup] of focusEffects.callbacks) {
      cleanup?.()
      focusEffects.callbacks.set(effect, effect())
    }
  })
}

function sessionScope() {
  const customKeys: CustomKey[] = []
  return {
    hostId: 'host',
    connState: 'connecting',
    customKeys,
    setTerminalTextScale: vi.fn(),
    terminalTextScaleRevisionRef: { current: 0 },
    setAutocompleteEnabled: vi.fn(),
    setTerminalLinkOpenMode: vi.fn(),
    setCustomKeys: vi.fn(),
    setVisibleBuiltInIds: vi.fn(),
    setDirectionPadEnabled: vi.fn(),
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
  pageBridge.client = null
  shellGeometry.sideRail = false
  focusEffects.callbacks.clear()
  focusEffects.appStateListeners.clear()
  vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
  vi.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined)
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

it('reloads custom visibility and order plus D-pad state when returning from Manage Shortcuts', async () => {
  const scope = sessionScope()
  let storedKeys = [{ id: 'one', label: 'One', bytes: '1', enter: false, visible: true }]
  let padEnabled = true
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) =>
    key === 'orca:custom-accessory-keys'
      ? JSON.stringify(storedKeys)
      : JSON.stringify({
          version: 2,
          orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
          visibleBuiltInIds: ['tab'],
          directionPadEnabled: padEnabled
        })
  )
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
    useMobileSessionLifecycle(scope as never)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(true)
  storedKeys = [{ ...storedKeys[0]!, visible: false }]
  padEnabled = false
  await act(async () => {
    for (const [effect, cleanup] of focusEffects.callbacks) {
      cleanup?.()
      focusEffects.callbacks.set(effect, effect())
    }
  })
  expect(scope.setCustomKeys).toHaveBeenLastCalledWith(storedKeys)
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(false)
})

it('finishes custom-key hydration when side-rail geometry arrives during the read', async () => {
  const customRead = deferred<string | null>()
  vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
    key === 'orca:custom-accessory-keys' ? customRead.promise : Promise.resolve(null)
  )
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
  shellGeometry.sideRail = true
  await act(async () => renderer!.update(createElement(Harness)))
  await act(async () => customRead.resolve('[]'))
  expect(ready).toBe(true)
  expect(scope.setCustomKeys).toHaveBeenLastCalledWith([])
  expect(scope.setVisibleBuiltInIds.mock.calls.at(-1)![0]).not.toContain('arrowUp')
})

it('refreshes a mounted terminal from native shortcut settings without router focus, remount or draft writes', async () => {
  const layoutKey = 'orca:terminal-accessory-layout'
  const customKey = 'orca:custom-accessory-keys'
  const draftKey = 'orca:terminalDrafts:host-a:wt-1'
  const layout = (ids: string[], pad: boolean) =>
    JSON.stringify({
      version: 2,
      orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
      visibleBuiltInIds: ids,
      directionPadEnabled: pad
    })
  const initial = layout(['escape', 'tab'], true)
  const storage: Record<string, string> = {
    [layoutKey]: initial,
    [customKey]: '[]',
    [draftKey]: 'old draft'
  }
  const pair = createFakeBridgePortPair({ route: { pathname: '/h/host-a/session/wt-1' }, storage })
  await pair.flush()
  pageBridge.client = pair.client
  publishPageStorage(
    storage,
    (key, value) => pair.client.notifyStorageWrite(key, value),
    'host-a',
    '/h/host-a/session/wt-1'
  )
  pair.client.onStorageUpdate(() => {
    const session = pair.client.getShellSession()!
    refreshPageTerminalShortcuts(session.storage, session.storageOversize)
  })
  vi.mocked(AsyncStorage.getItem).mockImplementation(pageAsyncStorage.getItem)
  const scope = sessionScope()
  let mounts = 0
  function Harness() {
    useEffect(() => {
      mounts += 1
    }, [])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
    useMobileSessionLifecycle(scope as never)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(true)
  await pageAsyncStorage.setItem(draftKey, 'unsent page draft')
  await pair.flush()
  const writes = pair.storageWrites.length
  storage[layoutKey] = layout(['enter', 'arrowUp'], false)
  storage[customKey] = JSON.stringify([{ id: 'two', label: 'Two', bytes: '2', enter: false }])
  await act(async () => {
    pair.host.publishStorage()
    await pair.flush()
  })
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(false)
  expect(scope.setVisibleBuiltInIds).toHaveBeenLastCalledWith(['enter', 'arrowUp'])
  expect(scope.setCustomKeys).toHaveBeenLastCalledWith([
    { id: 'two', label: 'Two', bytes: '2', enter: false }
  ])
  expect(await pageAsyncStorage.getItem(draftKey)).toBe('unsent page draft')
  expect(pair.storageWrites).toHaveLength(writes)
  expect(mounts).toBe(1)
  expect(pair.client.getShellSession()?.sessionId).toBe('session-a')

  // A local edit can differ from the last native snapshot even when native resets to that snapshot.
  await pageAsyncStorage.setItem(layoutKey, initial)
  await pair.flush()
  await act(async () => {
    pair.host.publishKeyboardInset(222)
    await pair.flush()
  })
  expect(await pageAsyncStorage.getItem(layoutKey)).toBe(initial)
  await act(async () => {
    pair.host.publishStorage()
    await pair.flush()
  })
  expect(await pageAsyncStorage.getItem(layoutKey)).toBe(storage[layoutKey])
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(false)

  delete storage[layoutKey]
  delete storage[customKey]
  const afterLocalWrite = pair.storageWrites.length
  await act(async () => {
    pair.host.publishStorage()
    await pair.flush()
  })
  expect(await pageAsyncStorage.getItem(layoutKey)).toBeNull()
  expect(scope.setDirectionPadEnabled).toHaveBeenLastCalledWith(true)
  expect(scope.setCustomKeys).toHaveBeenLastCalledWith([])
  expect(pair.storageWrites).toHaveLength(afterLocalWrite)
  pair.client.close()
  pair.host.dispose()
})

describe('session custom shortcuts after saved settings change', () => {
  const oldKey = { id: 'old', label: 'Old', bytes: 'old', enter: false }
  const newKey = { id: 'new', label: 'New', bytes: 'new\r', enter: false }
  const otherKey = { id: 'other', label: 'Other', bytes: 'other', enter: false }

  function storeCustomKeys(read: () => Promise<string | null>) {
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:custom-accessory-keys' ? read() : Promise.resolve(null)
    )
  }

  async function mountWithKeys(keys: CustomKey[]) {
    storeCustomKeys(async () => JSON.stringify(keys))
    const scope = sessionScope()
    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      useMobileSessionLifecycle(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    scope.customKeys = keys
    await act(async () => renderer?.update(createElement(Harness)))
    scope.setCustomKeys.mockClear()
    return { scope, rerender: () => renderer?.update(createElement(Harness)) }
  }

  it('rereads saved shortcuts on focus and on foreground', async () => {
    const { scope } = await mountWithKeys([oldKey])
    storeCustomKeys(async () => JSON.stringify([otherKey]))
    await act(async () => refocus())
    expect(scope.setCustomKeys).toHaveBeenLastCalledWith([otherKey])
    storeCustomKeys(async () => JSON.stringify([newKey]))
    await act(async () => {
      for (const listener of focusEffects.appStateListeners) {
        listener('active')
      }
    })
    expect(scope.setCustomKeys).toHaveBeenLastCalledWith([newKey])
  })

  it('keeps the live shortcuts when the refresh read fails', async () => {
    const { scope } = await mountWithKeys([oldKey])
    storeCustomKeys(() => Promise.reject(new Error('storage unavailable')))
    await act(async () => refocus())
    expect(scope.setCustomKeys).toHaveBeenCalledTimes(1)
    expect(scope.setCustomKeys).toHaveBeenLastCalledWith(scope.customKeys)
  })

  it('keeps a newer in-session edit when an older focus read settles', async () => {
    const { scope, rerender } = await mountWithKeys([oldKey])
    const read = deferred<string | null>()
    storeCustomKeys(() => read.promise)
    refocus()
    scope.customKeys = [newKey]
    await act(async () => rerender())
    await act(async () => read.resolve(JSON.stringify([oldKey])))
    expect(scope.setCustomKeys).not.toHaveBeenCalled()
  })

  it('ends on the last queued Settings write when focus reads between writes', async () => {
    const { scope } = await mountWithKeys([oldKey])
    let stored = JSON.stringify([oldKey])
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (_key, value) => {
      stored = value
    })
    const intermediateRead = deferred<string | null>()
    let focusRead = true
    storeCustomKeys(async () => {
      if (focusRead) {
        focusRead = false
        return intermediateRead.promise
      }
      return stored
    })
    refocus()
    await act(async () => {
      await saveCustomKeys([otherKey])
      intermediateRead.resolve(stored)
      await saveCustomKeys([otherKey, newKey])
    })
    expect(scope.setCustomKeys).toHaveBeenLastCalledWith([otherKey, newKey])
  })
})
