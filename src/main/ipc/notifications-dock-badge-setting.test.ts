import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  handleMock,
  removeHandlerMock,
  resetNotificationDispatchMocks,
  setDockBadgeVisibleMock
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

vi.mock('../dock/unread-badge', async () =>
  (await import('./notifications-test-harness')).createUnreadBadgeModuleMock()
)

import { registerNotificationHandlers } from './notifications'

type SettingsListener = (updates: unknown, settings: unknown) => void

function createStore(showDockBadge: boolean): {
  getSettings: () => { notifications: { showDockBadge: boolean } }
  onSettingsChanged: (listener: SettingsListener) => () => void
  listeners: SettingsListener[]
} {
  const listeners: SettingsListener[] = []
  return {
    listeners,
    getSettings: () => ({ notifications: { showDockBadge } }),
    onSettingsChanged: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) {
          listeners.splice(index, 1)
        }
      }
    }
  }
}

describe('dock badge visibility setting wiring', () => {
  beforeEach(() => {
    resetNotificationDispatchMocks()
    setDockBadgeVisibleMock.mockClear()
  })

  it('applies the persisted badge visibility at registration', () => {
    registerNotificationHandlers(createStore(false) as never)

    expect(setDockBadgeVisibleMock).toHaveBeenCalledWith(false)
  })

  it('reapplies badge visibility when notification settings change', () => {
    const store = createStore(false)
    registerNotificationHandlers(store as never)
    setDockBadgeVisibleMock.mockClear()

    expect(store.listeners).toHaveLength(1)
    store.listeners[0](
      { notifications: { showDockBadge: true } },
      { notifications: { showDockBadge: true } }
    )

    expect(setDockBadgeVisibleMock).toHaveBeenCalledWith(true)
  })

  it('ignores unrelated settings changes', () => {
    const store = createStore(true)
    registerNotificationHandlers(store as never)
    setDockBadgeVisibleMock.mockClear()

    store.listeners[0]({ enabled: false }, { notifications: { showDockBadge: true } })

    expect(setDockBadgeVisibleMock).not.toHaveBeenCalled()
  })

  it('still registers notification handlers when the store cannot notify changes', () => {
    registerNotificationHandlers({
      getSettings: () => ({ notifications: { showDockBadge: true } })
    } as never)

    expect(removeHandlerMock).toHaveBeenCalled()
    expect(handleMock).toHaveBeenCalled()
    expect(setDockBadgeVisibleMock).toHaveBeenCalledWith(true)
  })
})
