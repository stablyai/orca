import { createElement, useCallback, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStateStatus } from 'react-native'
import type { CustomKey } from '../components/CustomKeyModal'
import type { TerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

const harness = vi.hoisted(() => {
  const navigation: {
    focus: (() => void | (() => void)) | null
    blur: (() => void) | null
  } = { focus: null, blur: null }
  return {
    ...navigation,
    loadLayout: vi.fn<() => Promise<TerminalAccessoryLayout>>(),
    loadKeys: vi.fn<() => Promise<CustomKey[]>>(),
    setLayout: vi.fn(),
    setKeys: vi.fn(),
    listeners: new Set<(state: AppStateStatus) => void>()
  }
})

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Animated: { Value: class {} },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      harness.listeners.add(listener)
      return { remove: () => harness.listeners.delete(listener) }
    }
  }
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    useEffect(() => {
      harness.focus = effect
      harness.blur = effect() ?? null
      return () => {
        harness.blur?.()
        harness.focus = null
        harness.blur = null
      }
    }, [effect])
  }
}))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [] }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('../terminal/terminal-accessory-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal/terminal-accessory-layout')>()),
  loadTerminalAccessoryLayout: harness.loadLayout
}))
vi.mock('../components/CustomKeyModal', () => ({ loadCustomKeys: harness.loadKeys }))
vi.mock('../terminal/terminal-foreground-recovery', () => ({
  shouldRecoverTerminalOnAppStateChange: () => false,
  recoverActiveTerminalAfterForeground: () => 'skipped'
}))
vi.mock('./use-terminal-live-input-mode-preference', () => ({
  useTerminalLiveInputModePreference: () => ({})
}))
vi.mock('./use-initial-session-terminal-autocreate', () => ({
  useWorktreeSessionTabsLoaded: () => [true, () => {}]
}))

import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'

const firstLayout: TerminalAccessoryLayout = {
  orderedBuiltInIds: ['escape', 'tab'],
  visibleBuiltInIds: ['escape', 'tab']
}
const mixedLayout: TerminalAccessoryLayout = {
  ...firstLayout,
  orderedIds: ['custom:deploy', 'builtin:escape', 'builtin:tab']
}
const keys: CustomKey[] = [{ id: 'deploy', label: 'Deploy', bytes: 'deploy\r', enter: true }]
let tree: ReactTestRenderer | null = null
let screenState: ReturnType<typeof useMobileSessionScreenState> | null = null

function Harness() {
  const state = useMobileSessionScreenState(
    mountFixture({ worktreeId: 'workspace', hostId: '', initialCreateWarning: '' })
  )
  screenState = state
  const setCustomKeys = useCallback<typeof state.setCustomKeys>(
    (next) => {
      harness.setKeys(next)
      state.setCustomKeys(next)
    },
    [state.setCustomKeys]
  )
  const setLayout = useCallback<typeof state.setTerminalAccessoryLayout>(
    (next) => {
      harness.setLayout(next)
      state.setTerminalAccessoryLayout(next)
    },
    [state.setTerminalAccessoryLayout]
  )
  useMobileSessionLifecycle(
    mountFixture({
      hostId: '',
      connState: 'connected',
      customKeysRevisionRef: state.customKeysRevisionRef,
      setCustomKeys,
      setTerminalAccessoryLayout: setLayout
    })
  )
  return null
}
async function mount() {
  await act(async () => {
    tree = create(createElement(Harness))
  })
}
async function focus() {
  await act(async () => {
    harness.blur?.()
    harness.blur = harness.focus?.() ?? null
  })
}
async function foreground() {
  await act(async () => {
    harness.listeners.forEach((listener) => listener('active'))
  })
}

describe('session shortcut refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.loadLayout.mockResolvedValue(firstLayout)
    harness.loadKeys.mockResolvedValue([])
  })
  afterEach(() => {
    act(() => {
      tree?.unmount()
    })
    tree = null
    screenState = null
    expect(harness.listeners.size).toBe(0)
  })

  it('loads the full layout and keys together on first focus and return from settings', async () => {
    await mount()
    expect(harness.setLayout).toHaveBeenLastCalledWith(firstLayout)
    expect(harness.setKeys).toHaveBeenLastCalledWith([])
    harness.loadLayout.mockResolvedValue(mixedLayout)
    harness.loadKeys.mockResolvedValue(keys)
    await focus()
    expect(harness.setLayout).toHaveBeenLastCalledWith(mixedLayout)
    expect(harness.setKeys).toHaveBeenLastCalledWith(keys)
    expect(harness.loadKeys).toHaveBeenCalledTimes(2)
  })

  it('reloads both the mixed order and edited keys when the app returns to the foreground', async () => {
    await mount()
    harness.loadLayout.mockResolvedValue(mixedLayout)
    harness.loadKeys.mockResolvedValue(keys)
    await foreground()
    expect(harness.setLayout).toHaveBeenLastCalledWith(mixedLayout)
    expect(harness.setKeys).toHaveBeenLastCalledWith(keys)
  })

  it('does not apply a stale focus read after returning from settings', async () => {
    let finishOldRead: (keys: CustomKey[]) => void = () => {}
    harness.loadKeys.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOldRead = resolve
      })
    )
    await mount()
    expect(harness.setLayout).not.toHaveBeenCalled()
    harness.loadLayout.mockResolvedValue(mixedLayout)
    harness.loadKeys.mockResolvedValue(keys)
    await focus()
    await act(async () => {
      finishOldRead([])
    })
    expect(harness.setLayout).toHaveBeenCalledExactlyOnceWith(mixedLayout)
    expect(harness.setKeys).toHaveBeenCalledExactlyOnceWith(keys)
  })

  it('does not apply pending foreground reads after the screen unmounts', async () => {
    await mount()
    let finishRead: (keys: CustomKey[]) => void = () => {}
    harness.loadKeys.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )
    await foreground()
    act(() => {
      tree?.unmount()
    })
    tree = null
    await act(async () => {
      finishRead(keys)
    })
    expect(harness.setLayout).toHaveBeenCalledExactlyOnceWith(firstLayout)
    expect(harness.setKeys).toHaveBeenCalledExactlyOnceWith([])
  })

  it('does not let a pending foreground read replace a newer return from settings', async () => {
    await mount()
    let finishOldRead: (keys: CustomKey[]) => void = () => {}
    harness.loadKeys.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOldRead = resolve
      })
    )
    await foreground()
    harness.loadLayout.mockResolvedValue(mixedLayout)
    harness.loadKeys.mockResolvedValue(keys)
    await focus()
    await act(async () => {
      finishOldRead([])
    })
    expect(harness.setLayout).toHaveBeenCalledTimes(2)
    expect(harness.setLayout).toHaveBeenLastCalledWith(mixedLayout)
    expect(harness.setKeys).toHaveBeenCalledTimes(2)
    expect(harness.setKeys).toHaveBeenLastCalledWith(keys)
  })

  it.each([
    ['focus', 'add'],
    ['focus', 'delete'],
    ['foreground', 'add'],
    ['foreground', 'delete']
  ] as const)(
    '%s refresh preserves a local %s while layout is still loading',
    async (event, change) => {
      harness.loadKeys.mockResolvedValue(change === 'delete' ? keys : [])
      await mount()
      const originalSetter = screenState?.setCustomKeys
      let finishRead: (layout: TerminalAccessoryLayout) => void = () => {}
      harness.loadLayout.mockReturnValueOnce(
        new Promise((resolve) => {
          finishRead = resolve
        })
      )
      await (event === 'focus' ? focus() : foreground())
      act(() => {
        if (change === 'add') {
          screenState?.setCustomKeys((current) => [...current, ...keys])
        } else {
          screenState?.setCustomKeys([])
        }
      })
      await act(async () => {
        finishRead(mixedLayout)
      })
      expect(screenState?.customKeys).toEqual(change === 'add' ? keys : [])
      expect(screenState?.terminalAccessoryLayout).toEqual(mixedLayout)
      expect(screenState?.setCustomKeys).toBe(originalSetter)
      expect(harness.setKeys).toHaveBeenCalledTimes(1)
    }
  )
})
