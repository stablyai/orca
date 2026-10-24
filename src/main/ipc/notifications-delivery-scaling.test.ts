import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  getAllWindowsMock,
  resetNotificationDispatchMocks,
  getDismissHandler
} from './notifications-test-harness'
vi.mock('electron', async () => ({
  ...(await import('./notifications-test-harness')).createElectronModuleMock(),
  powerMonitor: { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 }
}))
vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)
vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)
vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)
vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
import { electronRuntimeDesktopSurface } from '../host/electron-runtime-desktop-surface'
import {
  getRuntimeDesktopSurface,
  setRuntimeDesktopSurface
} from '../runtime/runtime-desktop-surface'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { createHost, PANE, terminalHostCleanups } from '../runtime/terminal-phone-flow.test-fixture'
import { registerSubjectRetirement } from './notifications-subject-retirement.test-fixture'

const originalSurface = getRuntimeDesktopSurface()
beforeEach(() => {
  resetNotificationDispatchMocks()
  vi.useFakeTimers({ now: 100_000 })
})
afterEach(() => {
  for (const cleanup of terminalHostCleanups.splice(0)) {
    cleanup()
  }
  setRuntimeDesktopSurface(originalSurface)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([2, 20])(
  'scans W=%i real desktop-surface windows once per admitted notification and never on dismiss',
  (windows) => {
    const destroyed = vi.fn(() => false)
    const visible = vi.fn(() => false)
    getAllWindowsMock.mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exported surface calls only these two methods on the native-window boundary.
      Array.from({ length: windows }, () => ({
        isDestroyed: destroyed,
        isVisible: visible
      })) as never
    )
    setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
    const controller = new RuntimeMobileNotificationController()
    const dispatched = vi.fn()
    controller.onDispatched(dispatched)
    controller.dispatch({
      type: 'notification',
      source: 'test',
      notificationId: 'visible-scan',
      title: '',
      body: ''
    })
    expect(getAllWindowsMock).toHaveBeenCalledOnce()
    expect(destroyed).toHaveBeenCalledTimes(windows)
    expect(visible).toHaveBeenCalledTimes(windows)
    expect(dispatched).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification', desktopAway: true })
    )
    controller.dismiss('visible-scan')
    expect(getAllWindowsMock).toHaveBeenCalledOnce()
    console.info('desktop-surface-scaling', {
      windows,
      enumerations: 1,
      visits: destroyed.mock.calls.length + visible.mock.calls.length,
      dismissScans: 0
    })
  }
)

it('uses the same runtime announcement registry for a real host notification and pane-read IPC', () => {
  const { runtime, report, alerts } = createHost()
  const record = vi.spyOn(runtime.announcements, 'record')
  report('working')
  report('waiting')
  const announced = alerts.find((event) => event.type === 'notification')
  expect(announced?.notificationId).toBeTruthy()
  expect(record).toHaveBeenCalledOnce()
  registerSubjectRetirement({ suppressWhenFocused: false }, runtime.controller)
  const lookup = vi.spyOn(runtime.announcements, 'take')
  getDismissHandler()({}, [], [PANE])
  expect(lookup).toHaveBeenCalledExactlyOnceWith(PANE, undefined)
  expect(alerts.at(-1)).toMatchObject({
    type: 'dismiss',
    notificationId: announced!.notificationId
  })
  console.info('shared-registry-scaling', {
    recordAdmissions: record.mock.calls.length,
    paneReadLookups: lookup.mock.calls.length
  })
})
