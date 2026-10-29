import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import {
  runTerminalViewportFitPass,
  TerminalViewportResubscribeBudget
} from './mobile-terminal-viewport-resubscribe'
import type { Terminal } from './mobile-session-route-types'
import { useMobileSessionTerminalList } from './use-mobile-session-terminal-list'

const modes: TerminalModes = {
  bracketedPasteMode: true,
  altScreen: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false,
  applicationCursorKeysMode: false,
  kittyKeyboardFlags: 0,
  modifyOtherKeys: 0
}
let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function mount(retired: number, covered: boolean) {
  const handles = [...Array.from({ length: retired }, (_, index) => `closed-${index}`), 'live']
  const ptyModesRef = { current: new Map(handles.map((handle) => [handle, modes])) }
  const terminalCwdRef = { current: new Map(handles.map((handle) => [handle, `/work/${handle}`])) }
  const subscribeSeqRef = { current: new Map(handles.map((handle) => [handle, 4])) }
  const initialModesSeenRef = { current: new Set(handles) }
  const webReadyHandlesRef = { current: new Set(handles) }
  const budget = new TerminalViewportResubscribeBudget()
  const showNativeChatRef = { current: covered }
  const activeHandleRef = { current: covered ? 'closed-0' : 'live' }
  const initialDisplayModes = new Map(handles.map((handle) => [handle, 'phone' as const]))
  const liveTerminal: Terminal = { handle: 'live', title: 'Live', isActive: true }
  const terminalsRef = { current: [liveTerminal] }
  let available = true
  const client = stubRpcClient({
    sendRequest: async (method) => {
      expect(method).toBe('terminal.list')
      return available
        ? { id: 'inventory', ok: true, result: { terminals: [liveTerminal] } }
        : { id: 'inventory', ok: false, error: { code: 'unavailable', message: 'Retry' } }
    }
  })
  let current: {
    fetch: () => Promise<boolean>
    displayModes: typeof initialDisplayModes
  } | null = null
  function Harness() {
    const [, setTerminals] = useState<Terminal[]>([liveTerminal])
    const [displayModes, setTerminalModes] = useState(initialDisplayModes)
    const scope = {
      hostId: 'host',
      worktreeId: 'folder:terminal-cache',
      client,
      setTerminals,
      terminalsRef,
      sessionTabsRef: { current: [] },
      pruneTerminalHandlesFromLiveInput: vi.fn(),
      defaultTerminalHandlesToLiveInput: vi.fn(),
      clearTerminalLiveInputDefault: vi.fn(),
      setTerminalKeyboardMetrics: vi.fn(),
      setTerminalModes,
      ptyModesRef,
      terminalCwdRef,
      subscribeSeqRef,
      initialModesSeenRef,
      webReadyHandlesRef,
      terminalRefs: { current: new Map() },
      terminalUnsubsRef: { current: new Map() },
      viewportResubscribeBudgetRef: { current: budget },
      activeHandleRef,
      showNativeChatRef,
      unsubscribeTerminal: vi.fn(),
      nativeChatStream: { notifyListedHandles: vi.fn() },
      bufferedTerminalDraftState: { pruneDrafts: vi.fn() }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies all members read by this production inventory hook; unrelated route fields are unused.
    const list = useMobileSessionTerminalList(scope as never)
    current = { fetch: list.fetchTerminals, displayModes }
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  function read() {
    if (!current) {
      throw new Error('Inventory hook did not mount')
    }
    return current
  }
  return {
    budget,
    subscribeSeqRef,
    read,
    setAvailable: (next: boolean) => {
      available = next
    },
    leaveChat: () => {
      showNativeChatRef.current = false
      activeHandleRef.current = 'live'
    },
    caches: [
      ptyModesRef.current,
      terminalCwdRef.current,
      subscribeSeqRef.current,
      initialModesSeenRef.current,
      webReadyHandlesRef.current
    ],
    async refresh(expected = true) {
      await act(async () => expect(await read().fetch()).toBe(expected))
    }
  }
}

it.each([10, 100])(
  'releases metadata for %i retired terminals after accepted inventory',
  async (count) => {
    const inventory = await mount(count, false)
    await inventory.refresh()
    expect([...inventory.caches, inventory.read().displayModes].map((cache) => cache.size)).toEqual(
      [1, 1, 1, 1, 1, 1]
    )
    for (const cache of [...inventory.caches, inventory.read().displayModes]) {
      expect([...cache.keys()]).toEqual(['live'])
    }
    const unchanged = inventory.read().displayModes
    await inventory.refresh()
    expect(inventory.read().displayModes).toBe(unchanged)
  }
)

it('retains omitted chat input ownership and prunes it after coverage ends', async () => {
  const inventory = await mount(10, true)
  await inventory.refresh()
  for (const cache of [...inventory.caches, inventory.read().displayModes]) {
    expect([...cache.keys()]).toEqual(['closed-0', 'live'])
  }
  inventory.leaveChat()
  await inventory.refresh()
  for (const cache of [...inventory.caches, inventory.read().displayModes]) {
    expect([...cache.keys()]).toEqual(['live'])
  }
})

it('retains cached state on a refused inventory and releases it after recovery', async () => {
  const inventory = await mount(10, false)
  const before = inventory.read().displayModes
  inventory.setAvailable(false)
  await inventory.refresh(false)
  expect(inventory.read().displayModes).toBe(before)
  expect([...inventory.caches, inventory.read().displayModes].map((cache) => cache.size)).toEqual([
    11, 11, 11, 11, 11, 11
  ])
  inventory.setAvailable(true)
  await inventory.refresh()
  for (const cache of [...inventory.caches, inventory.read().displayModes]) {
    expect([...cache.keys()]).toEqual(['live'])
  }
})

it('invalidates a pending viewport fit before a retired handle reuses its sequence', async () => {
  const inventory = await mount(1, false)
  let releaseReady = () => {}
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve
  })
  const fitDimensions = vi.fn(() => ({ cols: 40, rows: 30 }))
  const subscribeToTerminal = vi.fn()
  const unsubscribeTerminal = vi.fn()
  runTerminalViewportFitPass({
    handle: 'closed-0',
    seq: 4,
    hostCols: 80,
    hostRows: 24,
    sentViewport: null,
    budget: inventory.budget,
    diagnostics: {
      streamResubscribing: vi.fn(),
      streamResubscribeHeld: vi.fn(),
      streamResubscribeExhausted: vi.fn()
    },
    viewportRef: { current: null },
    viewportMeasuredRef: { current: false },
    subscribeSeqRef: inventory.subscribeSeqRef,
    terminalUnsubsRef: { current: new Map() },
    terminalFrameRef: { current: { width: 390, height: 600 } },
    getTerminalRef: () => ({ awaitReady: () => ready, fitDimensions }),
    unsubscribeTerminal,
    subscribeToTerminal,
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn()
  })
  const retiredGeneration = inventory.budget.retryGeneration('closed-0')
  const liveGeneration = inventory.budget.retryGeneration('live')
  await inventory.refresh()
  inventory.subscribeSeqRef.current.set('closed-0', 4)
  expect(inventory.budget.retryGeneration('live')).toBe(liveGeneration)
  releaseReady()
  await Promise.resolve()
  expect(inventory.budget.isRetryGenerationCurrent('closed-0', retiredGeneration)).toBe(false)
  expect(fitDimensions).not.toHaveBeenCalled()
  expect(unsubscribeTerminal).not.toHaveBeenCalled()
  expect(subscribeToTerminal).not.toHaveBeenCalled()
})
