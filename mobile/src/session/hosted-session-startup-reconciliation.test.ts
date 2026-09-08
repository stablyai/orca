import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'
import type { SessionTabsResult } from './mobile-session-route-types'
import { useMobileSessionStartup } from './use-mobile-session-startup'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'

const lifecycle = vi.hoisted(() => ({
  focused: true,
  listeners: new Set<(state: string) => void>()
}))
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, listener: (state: string) => void) => {
      lifecycle.listeners.add(listener)
      return { remove: () => lifecycle.listeners.delete(listener) }
    }
  }
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(() => (lifecycle.focused ? effect() : undefined), [effect, lifecycle.focused])
  }
})

const noOp = () => {}
const noRecovery = () => false
let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  lifecycle.focused = true
  lifecycle.listeners.clear()
  vi.useRealTimers()
})

function snapshot(version: number): SessionTabsResult {
  return {
    worktree: 'workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: version,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function fixture(hosted: boolean, synchronousFrame = false) {
  vi.useFakeTimers()
  let connectionState: 'connected' | 'disconnected' = 'connected'
  let onSnapshot: (value: SessionTabsResult) => void = noOp
  let onError = noOp
  const pending: ReturnType<typeof Promise.withResolvers<SessionTabsResult>>[] = []
  const read = vi.fn(() => {
    const deferred = Promise.withResolvers<SessionTabsResult>()
    pending.push(deferred)
    return deferred.promise
  })
  const operations = {
    streamFirstStartup: hosted,
    snapshot: read,
    subscribe: (_: string, listener: typeof onSnapshot, error: typeof onError) => {
      onSnapshot = listener
      onError = error
      if (synchronousFrame) {
        listener(snapshot(1))
      }
      return noOp
    }
  } as unknown as HostSessionTabOperations
  const fetchTerminals = vi.fn(async (_options?: { allowEmptyLoaded?: boolean }) => true)
  const apply = vi.fn(() => ({ accepted: true as const, effectiveTabs: [] }))
  const scope = startupScope(fetchTerminals, operations)
  function Harness() {
    const actions = useMobileSessionTabsReconciliation({
      client: null,
      sessionTabOperations: operations,
      connState: connectionState,
      worktreeId: 'workspace',
      applySessionTabs: apply,
      consumeAcceptedSessionTabs: noOp,
      fetchTerminals,
      terminalInventoryRecoveryScopeKey: 'host:workspace',
      hasRecoveryNeed: noRecovery
    })
    useMobileSessionStartup({
      ...scope,
      connState: connectionState,
      ensureSessionTabs: actions.ensureSessionTabs
    } as MobileSessionKeyboardStateModel)
    return null
  }
  return {
    read,
    pending,
    fetchTerminals,
    apply,
    emit: (version: number) => onSnapshot(snapshot(version)),
    error: () => onError(),
    mount: async () => {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
    },
    connect: async (connected: boolean) => {
      connectionState = connected ? 'connected' : 'disconnected'
      await act(async () => {
        renderer?.update(createElement(Harness))
      })
    },
    focus: async (focused: boolean) => {
      lifecycle.focused = focused
      await act(async () => {
        renderer?.update(createElement(Harness))
      })
    }
  }
}

function startupScope(
  fetchTerminals: () => Promise<boolean>,
  sessionTabOperations: HostSessionTabOperations
) {
  const scope: Record<string, unknown> = {
    hostId: 'host',
    worktreeId: 'workspace',
    created: '0',
    isFloatingWorkspaceRoute: true,
    connState: 'connected',
    client: null,
    fetchTerminals,
    sessionTabOperations,
    terminalDiagnosticsRef: { current: { resetRoute: noOp } },
    fileDocLifecycleRef: { current: { reset: noOp } },
    markdownDocLifecycleRef: { current: { reset: noOp } },
    bufferedTerminalDraftState: { resetDrafts: noOp, clearPendingRestorations: noOp },
    initializedHandlesRef: { current: new Set() },
    closedTabTombstonesRef: { current: new Set() },
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Map() },
    sessionTabActionSheetRequestSeqRef: { current: 0 }
  }
  for (const key of [
    'setTerminals',
    'setSessionTabs',
    'setTerminalsLoaded',
    'setActiveHandle',
    'setActiveSessionTabId',
    'setMarkdownDocs',
    'setFileDocs',
    'clearPendingLiveInputCommit',
    'clearDelayedActionTimers',
    'showToast',
    'clearTerminalCache',
    'setWorkspaceTransportState'
  ]) {
    scope[key] = noOp
  }
  for (const key of [
    'terminalsRef',
    'appliedSnapshotMarkerRef',
    'sessionTabActionSheetKeyboardHideSubRef',
    'activeHandleRef',
    'activeSessionTabTypeRef',
    'pendingActiveSessionTabIdRef',
    'selectedSessionTabIdRef',
    'pendingActiveTerminalHandleRef',
    'pendingBrowserFocusPageIdRef',
    'pendingTerminalActivationAttemptRef',
    'initialSessionAutoCreateRef'
  ]) {
    scope[key] = { current: null }
  }
  return scope
}

describe('hosted session startup reconciliation', () => {
  it('omits both eager hosted reads, then certifies a newer version after the first frame', async () => {
    const f = fixture(true)
    await f.mount()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.fetchTerminals).toHaveBeenCalled()
    await act(async () => f.emit(1))
    expect(f.read).toHaveBeenCalledTimes(1)
    await act(async () => f.pending[0]!.resolve(snapshot(2)))
    expect(f.apply).toHaveBeenLastCalledWith(snapshot(2))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(f.read).toHaveBeenCalledTimes(1)
    await f.focus(false)
    await f.focus(true)
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('preserves native eager reads and distinct post-frame certification', async () => {
    const f = fixture(false)
    await f.mount()
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(
      f.fetchTerminals.mock.calls.some(([options]) => options?.allowEmptyLoaded === false)
    ).toBe(false)
    await act(async () => f.emit(1))
    expect(f.read).toHaveBeenCalledTimes(2)
    await act(async () => f.pending[0]!.resolve(snapshot(1)))
    await act(async () => f.pending[1]!.resolve(snapshot(2)))
    expect(f.apply).toHaveBeenLastCalledWith(snapshot(2))
  })

  it('certifies a first frame received before focus', async () => {
    const f = fixture(true, true)
    await f.mount()
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('retains eager reconciliation on reconnect after initial hosted startup', async () => {
    const f = fixture(true)
    await f.mount()
    await act(async () => f.emit(1))
    await act(async () => f.pending[0]!.resolve(snapshot(2)))
    await f.connect(false)
    await f.connect(true)
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('keeps bounded probing when no first frame arrives and immediate error recovery', async () => {
    const f = fixture(true)
    await f.mount()
    expect(f.read).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(f.read).toHaveBeenCalledTimes(1)
    await act(async () => f.error())
    expect(f.read).toHaveBeenCalledTimes(2)
  })
})
