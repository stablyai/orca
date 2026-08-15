import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  notificationShowMock,
  notificationCloseMock,
  notificationOnMock,
  notificationOnceMock,
  notificationRemoveListenerMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  getAllWindowsMock,
  shellOpenExternalMock
} = vi.hoisted(() => {
  const notificationShowMock = vi.fn()
  const notificationCloseMock = vi.fn()
  const notificationOnMock = vi.fn()
  const notificationOnceMock = vi.fn()
  const notificationRemoveListenerMock = vi.fn()
  return {
    removeHandlerMock: vi.fn(),
    handleMock: vi.fn(),
    notificationShowMock,
    notificationCloseMock,
    notificationOnMock,
    notificationOnceMock,
    notificationRemoveListenerMock,
    notificationCtorMock: vi.fn(function () {
      return {
        show: notificationShowMock,
        close: notificationCloseMock,
        on: notificationOnMock,
        once: notificationOnceMock,
        removeListener: notificationRemoveListenerMock
      }
    }),
    notificationIsSupportedMock: vi.fn(() => true),
    getAllWindowsMock: vi.fn(() => []),
    shellOpenExternalMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  Notification: Object.assign(notificationCtorMock, {
    isSupported: notificationIsSupportedMock
  }),
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  },
  app: {
    focus: vi.fn()
  },
  shell: {
    openExternal: shellOpenExternalMock
  }
}))

const { readAuthorizationStatusMock } = vi.hoisted(() => ({
  readAuthorizationStatusMock: vi.fn(
    (): Promise<'authorized' | 'denied' | 'not-determined' | 'unknown' | null> =>
      Promise.resolve(null)
  )
}))

vi.mock('./notification-authorization-status', () => ({
  readNotificationAuthorizationStatus: readAuthorizationStatusMock
}))

// Why: notifications.ts pulls in the tray module, which transitively loads
// app-icon/electron-toolkit; stub it to keep this suite import-light.
vi.mock('../tray/system-tray', () => ({
  setTrayAttention: vi.fn()
}))

import {
  registerNotificationHandlers,
  triggerStartupNotificationRegistration
} from './notifications'

// Regression: while macOS authorization is 'not-determined', showing a notification is the
// only thing that makes the OS present the permission dialog — so nothing may short-circuit it.
describe('macOS notification permission prompt while the decision is pending', () => {
  const originalPlatform = process.platform

  function createStore(ui: Record<string, unknown> = {}): {
    getSettings: () => unknown
    getUI: () => Record<string, unknown>
    updateUI: ReturnType<typeof vi.fn>
  } {
    const state = { ...ui }
    return {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      }),
      getUI: () => state,
      updateUI: vi.fn((updates: Record<string, unknown>) => {
        Object.assign(state, updates)
      })
    }
  }

  function getDispatchHandler(): (event: unknown, args: unknown) => unknown {
    const call = handleMock.mock.calls.findLast((c: unknown[]) => c[0] === 'notifications:dispatch')
    if (!call) {
      throw new Error('notifications:dispatch handler not registered')
    }
    return call[1] as (event: unknown, args: unknown) => unknown
  }

  function getProbeDeliveryHandler(): (event: unknown, args?: unknown) => Promise<unknown> {
    const call = handleMock.mock.calls.findLast(
      (c: unknown[]) => c[0] === 'notifications:probeDelivery'
    )
    if (!call) {
      throw new Error('notifications:probeDelivery handler not registered')
    }
    return call[1] as (event: unknown, args?: unknown) => Promise<unknown>
  }

  function getNotificationOnceEventHandler(eventName: string): () => void {
    const call = notificationOnceMock.mock.calls.findLast((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Notification ${eventName} once handler not registered`)
    }
    return call[1] as () => void
  }

  beforeEach(() => {
    vi.useFakeTimers()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    notificationCtorMock.mockClear()
    notificationShowMock.mockClear()
    notificationCloseMock.mockClear()
    notificationOnMock.mockClear()
    notificationOnceMock.mockClear()
    notificationRemoveListenerMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    readAuthorizationStatusMock.mockReset()
    readAuthorizationStatusMock.mockResolvedValue('not-determined')
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.useRealTimers()
  })

  it('sends the test notification so macOS can present the permission dialog', async () => {
    const store = createStore({ notificationPermissionRequested: true })
    registerNotificationHandlers(store as never)

    const result = getDispatchHandler()({}, { source: 'test', requireDisplayConfirmation: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)

    // A queued-behind-the-dialog request still emits 'show', so while the decision stays pending
    // the re-read keeps the answer honest.
    getNotificationOnceEventHandler('show')()
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).resolves.toEqual({ delivered: false, reason: 'blocked-by-system' })
  })

  it('reports success when the user allows and the banner really displays', async () => {
    const store = createStore({ notificationPermissionRequested: true })
    registerNotificationHandlers(store as never)
    // The dialog opens on show(); by the time 'show' confirms, the user has clicked Allow.
    readAuthorizationStatusMock.mockResolvedValueOnce('not-determined')
    readAuthorizationStatusMock.mockResolvedValue('authorized')

    const result = getDispatchHandler()({}, { source: 'test', requireDisplayConfirmation: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)

    getNotificationOnceEventHandler('show')()
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).resolves.toEqual({ delivered: true })
  })

  it('leaves no delivered evidence behind when the helper later goes missing', async () => {
    const store = createStore({ notificationPermissionRequested: true })
    registerNotificationHandlers(store as never)

    const dispatched = getDispatchHandler()(
      {},
      { source: 'test', requireDisplayConfirmation: true }
    )
    await vi.advanceTimersByTimeAsync(0)
    getNotificationOnceEventHandler('show')()
    await dispatched

    // Helper gone (timeout / missing binary): the cached-evidence branch must not claim success.
    readAuthorizationStatusMock.mockResolvedValue(null)
    const probe = getProbeDeliveryHandler()({})
    await vi.advanceTimersByTimeAsync(0)
    getNotificationOnceEventHandler('show')()

    await expect(probe).resolves.toEqual({ state: 'delivered', authoritative: false })
    // Why: 'delivered' here comes from a fresh probe, not stale dispatch evidence.
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })

  it('reports not-displayed when the pending decision swallows the test notification', async () => {
    const store = createStore({ notificationPermissionRequested: true })
    registerNotificationHandlers(store as never)

    const result = getDispatchHandler()({}, { source: 'test', requireDisplayConfirmation: true })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2501)

    await expect(result).resolves.toEqual({ delivered: false, reason: 'not-displayed' })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('keeps reaching the OS on every dispatch instead of once per session', async () => {
    const store = createStore({ notificationPermissionRequested: true })
    registerNotificationHandlers(store as never)
    const handler = getDispatchHandler()

    const first = handler({}, { source: 'agent-task-complete', worktreeId: 'repo::a' })
    await vi.advanceTimersByTimeAsync(0)
    // Unconfirmed sends stay honest: macOS accepted the request but displays nothing yet.
    await expect(first).resolves.toEqual({ delivered: false, reason: 'blocked-by-system' })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)

    const second = handler({}, { source: 'terminal-bell', worktreeId: 'repo::b' })
    await vi.advanceTimersByTimeAsync(0)
    await expect(second).resolves.toEqual({ delivered: false, reason: 'blocked-by-system' })
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })

  it('re-arms startup registration when the flag was stamped without an OS prompt', async () => {
    const store = createStore({ notificationPermissionRequested: true })

    await triggerStartupNotificationRegistration(store as never)

    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('fires one welcome notification when startup registration is triggered concurrently', async () => {
    const store = createStore()

    await Promise.all([
      triggerStartupNotificationRegistration(store as never),
      triggerStartupNotificationRegistration(store as never)
    ])

    expect(notificationCtorMock).toHaveBeenCalledTimes(1)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })
})
