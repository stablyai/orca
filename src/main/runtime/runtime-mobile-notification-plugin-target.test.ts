import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

afterEach(() => setRuntimeDesktopSurface(null))

it('routes a plugin notification target to the desktop click and the phone event', async () => {
  const showNotification = vi.fn(() => true)
  setRuntimeDesktopSurface({
    showNotification,
    findWindowById: () => null,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const controller = new RuntimeMobileNotificationController()
  const events: MobileNotificationEvent[] = []
  controller.onDispatched((event) => events.push(event))
  const target = { worktreeId: 'repo::wt1', paneKey: 'tab-1:11111111-1111-4111-8111-111111111111' }

  await expect(
    controller.dispatchPlugin({ pluginId: 'u1.lead', title: 'Done', body: 'Finished', target })
  ).resolves.toEqual({ delivered: true })

  expect(showNotification).toHaveBeenCalledWith({
    title: 'u1.lead: Done',
    body: 'Finished',
    target
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: 'notification',
    source: 'plugin',
    worktreeId: 'repo::wt1'
  })
})
