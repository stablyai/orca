import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getNotificationEventHandler,
  notificationOnMock,
  notificationRemoveListenerMock,
  resetNotificationDispatchMocks
} from '../ipc/notifications-test-harness'

const { reveal, createNotificationRevealHandler } = vi.hoisted(() => {
  const reveal = vi.fn()
  return { reveal, createNotificationRevealHandler: vi.fn(() => reveal) }
})

vi.mock('electron', async () =>
  (await import('../ipc/notifications-test-harness')).createElectronModuleMock()
)

vi.mock('../ipc/notification-reveal-target', () => ({ createNotificationRevealHandler }))

import { electronRuntimeDesktopSurface } from './electron-runtime-desktop-surface'

beforeEach(() => {
  resetNotificationDispatchMocks()
  reveal.mockClear()
  createNotificationRevealHandler.mockClear()
})

describe('electronRuntimeDesktopSurface.showNotification', () => {
  it('reveals the target on click', () => {
    const target = { worktreeId: 'repo::wt1', paneKey: 'tab-1:leaf-1' }
    electronRuntimeDesktopSurface.showNotification({ title: 't', body: 'b', target })

    expect(createNotificationRevealHandler).toHaveBeenCalledWith(target)
    getNotificationEventHandler('click')()
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('releases the click action when the notification fails to display', () => {
    electronRuntimeDesktopSurface.showNotification({
      title: 't',
      body: 'b',
      target: { worktreeId: 'repo::wt1' }
    })

    getNotificationEventHandler('failed')()
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('binds no click action without a target', () => {
    electronRuntimeDesktopSurface.showNotification({ title: 't', body: 'b' })

    expect(notificationOnMock).not.toHaveBeenCalledWith('click', expect.anything())
  })
})
