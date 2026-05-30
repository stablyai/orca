import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  notificationCtorMock,
  notificationIsSupportedMock,
  notificationOnMock,
  notificationRemoveListenerMock,
  notificationShowMock,
  shellOpenExternalMock,
  isTrustedAccessibilityClientMock
} = vi.hoisted(() => {
  const notificationOnMock = vi.fn()
  const notificationRemoveListenerMock = vi.fn()
  const notificationShowMock = vi.fn()
  const notificationCtorMock = vi.fn(function () {
    return {
      on: notificationOnMock,
      removeListener: notificationRemoveListenerMock,
      show: notificationShowMock
    }
  })
  return {
    notificationCtorMock,
    notificationIsSupportedMock: vi.fn(() => true),
    notificationOnMock,
    notificationRemoveListenerMock,
    notificationShowMock,
    shellOpenExternalMock: vi.fn(),
    isTrustedAccessibilityClientMock: vi.fn(() => false)
  }
})

vi.mock('electron', () => ({
  Notification: Object.assign(notificationCtorMock, {
    isSupported: notificationIsSupportedMock
  }),
  shell: {
    openExternal: shellOpenExternalMock
  },
  systemPreferences: {
    isTrustedAccessibilityClient: isTrustedAccessibilityClientMock
  }
}))

import { notifyPermissionRequired } from './permissions'

describe('notifyPermissionRequired', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllTimers()
    notificationCtorMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    notificationOnMock.mockClear()
    notificationRemoveListenerMock.mockClear()
    notificationShowMock.mockClear()
    shellOpenExternalMock.mockClear()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  function getNotificationEventHandler(eventName: string): () => void {
    const call = notificationOnMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Notification ${eventName} handler not registered`)
    }
    return call[1] as () => void
  }

  it('clears the retained notification fallback timer when the notification closes', () => {
    notifyPermissionRequired('Enable accessibility')

    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    const closeHandler = getNotificationEventHandler('close')
    closeHandler()

    expect(vi.getTimerCount()).toBe(0)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('close', closeHandler)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('opens macOS Accessibility settings on click after releasing notification state', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    notifyPermissionRequired('Enable accessibility')

    getNotificationEventHandler('click')()

    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      expect.stringContaining('Privacy_Accessibility')
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
