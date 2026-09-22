import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  handleMock,
  notificationCloseMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  notificationOnMock,
  notificationOnceMock,
  notificationRemoveListenerMock,
  notificationShowMock,
  readAuthorizationStatusMock,
  removeHandlerMock,
  shellOpenExternalMock
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'
import { triggerStartupNotificationRegistration } from './startup-notification-registration'

describe('notifications:probeDelivery', () => {
  const originalPlatform = process.platform

  function getProbeDeliveryHandler(): (event: unknown, args?: { force?: boolean }) => unknown {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'notifications:probeDelivery'
    )
    if (!call) {
      throw new Error('notifications:probeDelivery handler not registered')
    }
    return call[1] as (event: unknown, args?: { force?: boolean }) => unknown
  }

  function getProbeOnceEventHandler(eventName: string): (...args: unknown[]) => void {
    // Why: findLast — a test may run several probes, and only the newest
    // probe's listeners can settle the pending promise.
    const call = notificationOnceMock.mock.calls.findLast((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Probe notification ${eventName} once handler not registered`)
    }
    return call[1] as (...args: unknown[]) => void
  }

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
    readAuthorizationStatusMock.mockResolvedValue(null)
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('reports unsupported on non-darwin platforms without probing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const store = createStore()
    registerNotificationHandlers(store as never)

    await expect(getProbeDeliveryHandler()({})).resolves.toEqual({
      state: 'unsupported',
      authoritative: false
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
    expect(store.updateUI).not.toHaveBeenCalled()
  })

  it('reports authoritative states straight from the authorization readout', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)
    const handler = getProbeDeliveryHandler()

    readAuthorizationStatusMock.mockResolvedValue('authorized')
    expect(await handler({})).toEqual({ state: 'delivered', authoritative: true })

    readAuthorizationStatusMock.mockResolvedValue('denied')
    expect(await handler({})).toEqual({ state: 'blocked', authoritative: true })

    // No probe notifications were needed for either readout.
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('fires one dialog-trigger probe per session while the decision is pending', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)
    const handler = getProbeDeliveryHandler()
    readAuthorizationStatusMock.mockResolvedValue('not-determined')

    expect(await handler({})).toEqual({
      state: 'awaiting-decision',
      authoritative: true
    })
    expect(notificationCtorMock).toHaveBeenCalledTimes(1)

    // Polling again while pending must not spam more probe notifications.
    expect(await handler({}, { force: true })).toEqual({
      state: 'awaiting-decision',
      authoritative: true
    })
    expect(notificationCtorMock).toHaveBeenCalledTimes(1)
  })

  it('marks the one-shot permission registration as done so startup cannot re-prompt', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)

    const result = getProbeDeliveryHandler()({}) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    expect(store.updateUI).toHaveBeenCalledWith({ notificationPermissionRequested: true })

    getProbeOnceEventHandler('failed')({}, 'not allowed')
    await expect(result).resolves.toEqual({ state: 'blocked', authoritative: false })
  })

  it('falls back to delivery probes when the readout is unavailable', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)

    const result = getProbeDeliveryHandler()({}) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)

    getProbeOnceEventHandler('show')()
    await expect(result).resolves.toEqual({ state: 'delivered', authoritative: false })
    // No persisted confirmation on purpose: OS permission changes between runs.
    expect(store.updateUI).not.toHaveBeenCalledWith({ notificationDeliveryConfirmed: true })
  })

  it('serves session evidence without probing again until forced', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)
    const handler = getProbeDeliveryHandler()

    const probeResult = handler({}) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    getProbeOnceEventHandler('show')()
    await expect(probeResult).resolves.toEqual({ state: 'delivered', authoritative: false })
    expect(notificationCtorMock).toHaveBeenCalledTimes(1)

    // Cached session evidence answers non-force calls with no new probe.
    expect(await handler({})).toEqual({ state: 'delivered', authoritative: false })
    expect(notificationCtorMock).toHaveBeenCalledTimes(1)

    // Force bypasses the cache and schedules a fresh probe.
    const forced = handler({}, { force: true }) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationCtorMock).toHaveBeenCalledTimes(2)
    getProbeOnceEventHandler('show')()
    await expect(forced).resolves.toEqual({ state: 'delivered', authoritative: false })
  })

  it('serves cached failure evidence after a rejected probe', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)
    const handler = getProbeDeliveryHandler()

    const probeResult = handler({}, { force: true }) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    getProbeOnceEventHandler('failed')({}, 'Notifications are not allowed for this application')
    await expect(probeResult).resolves.toEqual({ state: 'blocked', authoritative: false })

    expect(await handler({})).toEqual({ state: 'blocked', authoritative: false })
    expect(notificationCtorMock).toHaveBeenCalledTimes(1)
  })

  it('resolves blocked on timeout without recording a definitive failure', async () => {
    const store = createStore()
    registerNotificationHandlers(store as never)
    const handler = getProbeDeliveryHandler()

    const probeResult = handler({}) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(3001)
    await expect(probeResult).resolves.toEqual({ state: 'blocked', authoritative: false })
    expect(notificationCloseMock).toHaveBeenCalledTimes(1)

    // A timeout is ambiguous evidence, so the next non-force call probes again.
    const secondResult = handler({}) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationCtorMock).toHaveBeenCalledTimes(2)
    getProbeOnceEventHandler('show')()
    await expect(secondResult).resolves.toEqual({ state: 'delivered', authoritative: false })
  })
})

describe('triggerStartupNotificationRegistration', () => {
  const originalPlatform = process.platform

  function getStartupNotificationEventHandler(eventName: string): (...args: unknown[]) => void {
    const call = notificationOnMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Startup notification ${eventName} handler not registered`)
    }
    return call[1] as (...args: unknown[]) => void
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllTimers()
    notificationCtorMock.mockClear()
    notificationShowMock.mockClear()
    notificationCloseMock.mockClear()
    notificationOnMock.mockClear()
    notificationRemoveListenerMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('shows welcome notification when not yet requested', async () => {
    const store = {
      getUI: () => ({ notificationPermissionRequested: undefined }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(store.updateUI).toHaveBeenCalledWith({ notificationPermissionRequested: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Orca is ready to notify you',
      body: 'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('does not fire when notificationPermissionRequested flag is set', async () => {
    const store = {
      getUI: () => ({ notificationPermissionRequested: true }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('does nothing on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const store = {
      getUI: () => ({ notificationPermissionRequested: undefined }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('clears startup notification timers when the notification is clicked', async () => {
    const store = {
      getUI: () => ({ notificationPermissionRequested: undefined }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)
    expect(vi.getTimerCount()).toBe(1)

    getStartupNotificationEventHandler('click')()

    expect(notificationCloseMock).toHaveBeenCalledTimes(1)
    expect(shellOpenExternalMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('click', expect.any(Function))
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('show', expect.any(Function))
  })

  it('cleans up startup notification registration when native delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = {
        getUI: () => ({ notificationPermissionRequested: undefined }),
        updateUI: vi.fn()
      }

      triggerStartupNotificationRegistration(store as never)
      expect(vi.getTimerCount()).toBe(1)

      const failedHandler = getStartupNotificationEventHandler('failed')
      failedHandler({}, 'Application is not code signed')

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('startup registration notification failed to show')
      )
      expect(notificationCloseMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(notificationRemoveListenerMock).toHaveBeenCalledWith('failed', failedHandler)
    } finally {
      warn.mockRestore()
    }
  })
})
