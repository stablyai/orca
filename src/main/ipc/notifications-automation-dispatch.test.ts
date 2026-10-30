import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { getDefaultSettings } from '../../shared/constants'
import {
  getDispatchHandler,
  getNotificationEventHandler,
  resetNotificationDispatchMocks
} from './notifications-test-harness'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
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
vi.mock('../startup/automation-run-navigation', () => ({ openAutomationRun: mocks.open }))
import {
  registerNotificationHandlers,
  dispatchRegisteredNotification,
  clearRegisteredNotificationDelivery
} from './notifications'
beforeEach(() => {
  resetNotificationDispatchMocks()
  clearRegisteredNotificationDelivery()
  mocks.open.mockClear()
})
afterEach(clearRegisteredNotificationDelivery)
it('shares the IPC service and cooldown, is unavailable outside registration, and binds pane-less run clicks', async () => {
  const request = {
    source: 'agent-task-complete',
    attentionKey: 'automation-outcome',
    automationRun: { automationId: 'a', runId: 'r' }
  } as const
  expect(await dispatchRegisteredNotification(request)).toEqual({
    delivered: false,
    reason: 'unavailable'
  })
  // SAFETY: notification registration reads only settings in this fixture.
  const store = { getSettings: () => getDefaultSettings('/fixture') } as Store
  registerNotificationHandlers(store)
  expect(await dispatchRegisteredNotification(request)).toEqual({ delivered: true })
  expect(await getDispatchHandler()({}, request)).toEqual({ delivered: false, reason: 'cooldown' })
  getNotificationEventHandler('click')()
  expect(mocks.open).toHaveBeenCalledWith(request.automationRun)
  clearRegisteredNotificationDelivery()
  expect(await dispatchRegisteredNotification(request)).toEqual({
    delivered: false,
    reason: 'unavailable'
  })
})
