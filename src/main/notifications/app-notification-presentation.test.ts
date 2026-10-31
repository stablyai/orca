import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
const mocks = vi.hoisted(() => ({
  ui: vi.fn(),
  execute: vi.fn(),
  destroy: vi.fn(),
  load: vi.fn(),
  construct: vi.fn(),
  selection: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      mocks.construct(options)
    }
    webContents = { executeJavaScript: mocks.execute }
    isDestroyed = () => false
    destroy = mocks.destroy
    loadURL = mocks.load
  }
}))
vi.mock('../ipc/ui', () => ({ getTrustedUIRendererWindow: mocks.ui }))
vi.mock('../ipc/notification-sound-selection', () => ({
  getEffectiveNotificationSoundId: mocks.selection
}))
import {
  presentAppNotificationResult,
  closeAppNotificationPresentation
} from './app-notification-presentation'
const settings = { ...getDefaultSettings('/fixture').notifications, customSoundVolume: 37 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.selection.mockReturnValue('bong')
  mocks.ui.mockReturnValue(null)
  mocks.load.mockResolvedValue(undefined)
  mocks.execute.mockResolvedValue(undefined)
})
afterEach(() => {
  closeAppNotificationPresentation()
  vi.useRealTimers()
})
it('uses the existing preload sound player and volume in a hidden owned window when the UI is closed', async () => {
  const playing = Promise.withResolvers<void>()
  mocks.execute.mockReturnValue(playing.promise)
  const pending = presentAppNotificationResult({ delivered: true }, settings)
  await Promise.resolve()
  expect(mocks.construct).toHaveBeenCalledWith(
    expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      })
    })
  )
  expect(mocks.execute).toHaveBeenCalledWith(
    'window.api.notifications.playSound({"volume":37,"waitUntilEnded":true})'
  )
  expect(mocks.destroy).not.toHaveBeenCalled()
  playing.resolve()
  await pending
  expect(mocks.destroy).toHaveBeenCalledOnce()
})
it('reuses the UI player, stays silent for suppressed/system sound outcomes, and forwards the existing permission fallback', async () => {
  const send = vi.fn()
  mocks.ui.mockReturnValue({
    isDestroyed: () => false,
    webContents: { executeJavaScript: mocks.execute, send }
  })
  await presentAppNotificationResult({ delivered: true }, settings)
  expect(mocks.execute).toHaveBeenCalledWith(
    'window.api.notifications.playSound({"volume":37,"waitUntilEnded":false})'
  )
  await presentAppNotificationResult({ delivered: false, reason: 'blocked-by-system' }, settings)
  expect(send).toHaveBeenCalledWith('automations:changed', {
    notificationResult: { delivered: false, reason: 'blocked-by-system' }
  })
  await presentAppNotificationResult({ delivered: false, reason: 'disabled' }, settings)
  mocks.selection.mockReturnValue('system')
  await presentAppNotificationResult({ delivered: true }, settings)
  expect(mocks.execute).toHaveBeenCalledOnce()
  expect(mocks.construct).not.toHaveBeenCalled()
})
it('bounds the lifetime of a hidden sound renderer that never becomes ready', async () => {
  vi.useFakeTimers()
  mocks.load.mockReturnValue(new Promise(() => {}))
  void presentAppNotificationResult({ delivered: true }, settings)
  await vi.advanceTimersByTimeAsync(35_000)
  expect(mocks.destroy).toHaveBeenCalledOnce()
})
