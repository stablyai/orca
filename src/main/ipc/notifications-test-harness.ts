import { vi } from 'vitest'
import type { Mock } from 'vitest'

// Why: mock state lives in this module so each split suite's `vi.mock` factory can
// pull it in with a lazy dynamic import (hoisted factories cannot close over imports).

/** Unconstrained spy; annotated explicitly so declaration emit never names @vitest/spy internals. */
export type NotificationSpy = Mock<(...args: never[]) => unknown>

export const removeHandlerMock: NotificationSpy = vi.fn()
export const handleMock: NotificationSpy = vi.fn()
export const notificationShowMock: NotificationSpy = vi.fn()
export const notificationCloseMock: NotificationSpy = vi.fn()
export const notificationOnMock: NotificationSpy = vi.fn()
export const notificationOnceMock: NotificationSpy = vi.fn()
export const notificationRemoveListenerMock: NotificationSpy = vi.fn()
export const notificationCtorMock: NotificationSpy = vi.fn(function () {
  return {
    show: notificationShowMock,
    close: notificationCloseMock,
    on: notificationOnMock,
    once: notificationOnceMock,
    removeListener: notificationRemoveListenerMock
  }
})
export const notificationIsSupportedMock = vi.fn(() => true)
export const getAllWindowsMock = vi.fn(() => [])
export const getTrustedUIRendererWindowMock: NotificationSpy = vi.fn()
export const shellOpenExternalMock: NotificationSpy = vi.fn()
export const setTrayAttentionMock: NotificationSpy = vi.fn()
export const readAuthorizationStatusMock = vi.fn(
  (): Promise<'authorized' | 'denied' | 'not-determined' | 'unknown' | null> =>
    Promise.resolve(null)
)

export function createElectronModuleMock(): Record<string, unknown> {
  return {
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
  }
}

export function createNotificationAuthorizationModuleMock(): Record<string, unknown> {
  return { readNotificationAuthorizationStatus: readAuthorizationStatusMock }
}

export function createTrustedUIRendererModuleMock(): Record<string, unknown> {
  return { getTrustedUIRendererWindow: getTrustedUIRendererWindowMock }
}

// Why: notifications.ts pulls in the tray module (for the minimized attention
// dot), which transitively loads app-icon/electron-toolkit; stub it so these
// suites stay focused on notification dispatch and avoid that import chain.
export function createSystemTrayModuleMock(): Record<string, unknown> {
  return { setTrayAttention: setTrayAttentionMock }
}

export function resetNotificationDispatchMocks(): void {
  removeHandlerMock.mockReset()
  handleMock.mockReset()
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
  getAllWindowsMock.mockReset()
  getAllWindowsMock.mockReturnValue([])
  getTrustedUIRendererWindowMock.mockReset()
  getTrustedUIRendererWindowMock.mockReturnValue(null)
  shellOpenExternalMock.mockClear()
  setTrayAttentionMock.mockClear()
}

function findRegisteredHandler(channel: string): unknown {
  const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1]
}

export function getDispatchHandler(): (event: unknown, args: unknown) => unknown {
  return findRegisteredHandler('notifications:dispatch') as (
    event: unknown,
    args: unknown
  ) => unknown
}

export function getDismissHandler(): (event: unknown, args: unknown) => unknown {
  return findRegisteredHandler('notifications:dismiss') as (
    event: unknown,
    args: unknown
  ) => unknown
}

export function getOpenSystemSettingsHandler(): (event: unknown) => unknown {
  return findRegisteredHandler('notifications:openSystemSettings') as (event: unknown) => unknown
}

export function getLoadSoundHandler(): (event: unknown) => Promise<unknown> {
  return findRegisteredHandler('notifications:loadSound') as (event: unknown) => Promise<unknown>
}

export function getResolveSoundPathHandler(): (event: unknown) => unknown {
  return findRegisteredHandler('notifications:resolveSoundPath') as (event: unknown) => unknown
}

export function getNotificationEventHandler(eventName: string): (...args: unknown[]) => void {
  const call = notificationOnMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
  if (!call) {
    throw new Error(`Notification ${eventName} handler not registered`)
  }
  return call[1] as (...args: unknown[]) => void
}

export function getNotificationOnceEventHandler(eventName: string): () => void {
  const call = notificationOnceMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
  if (!call) {
    throw new Error(`Notification ${eventName} once handler not registered`)
  }
  return call[1] as () => void
}
