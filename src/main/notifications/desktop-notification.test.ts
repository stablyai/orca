import { Notification } from 'electron'
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverNativeNotification } from '../ipc/notifications/native-notification-delivery'
import { trackNotificationDisplay } from '../ipc/notifications/native-notification-lifecycle'
import type { NotificationSettings } from '../../shared/notifications/notification-settings-types'
import { closeDesktopNotification, showDesktopNotification } from './desktop-notification'

const runProcess = vi.hoisted(() => vi.fn())
const native: { latest?: EventEmitter } = {}
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../ipc/ui', () => ({ getTrustedUIRendererWindow: () => null }))
vi.mock('../ipc/notifications/notification-permission-probe', () => ({
  recordNotificationDeliveryOutcome: () => {}
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Notification: class extends EventEmitter {
      constructor() {
        super()
        native.latest = this
      }
      show() {
        this.emit('show')
      }
      close() {
        this.emit('close', {})
      }
    }
  }
})

const settings: NotificationSettings = {
  enabled: true,
  agentTaskComplete: true,
  agentNeedsInput: true,
  terminalBell: true,
  suppressWhenFocused: false,
  customSoundId: 'system',
  customSoundPath: null,
  customSoundVolume: 1,
  mutedNotificationSourceIds: [],
  notifyHiddenWorkspaces: true
}

function dispatch() {
  return deliverNativeNotification(
    { source: 'test', requireDisplayConfirmation: true },
    { title: 'Test', body: '' },
    settings
  )
}

function confirmDisplay(notification: Notification): Promise<boolean> {
  const confirmation = trackNotificationDisplay(notification)
  showDesktopNotification(notification, confirmation.start)
  return confirmation.result
}

describe('Linux desktop notification admission', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    runProcess.mockReset()
  })

  it('reports failed activation as undelivered and retries when the notification service recovers', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess.mockResolvedValueOnce({ code: 1 }).mockResolvedValueOnce({ code: 0 })
    const duringOutage = new Notification()
    const undelivered = confirmDisplay(duringOutage)
    await expect(undelivered).resolves.toBe(false)

    const afterRecovery = new Notification()
    const delivered = confirmDisplay(afterRecovery)
    await expect(delivered).resolves.toBe(true)
  })

  it('discards a pending notification when a replacement arrives during activation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const activation = Promise.withResolvers<{ code: number }>()
    runProcess.mockReturnValue(activation.promise)

    const previous = new Notification()
    const replaced = confirmDisplay(previous)
    const displayed = vi.fn()
    previous.on('show', displayed)
    closeDesktopNotification(previous)

    const successor = new Notification()
    const delivered = confirmDisplay(successor)
    activation.resolve({ code: 0 })
    await expect(replaced).resolves.toBe(false)
    await expect(delivered).resolves.toBe(true)
    expect(displayed).not.toHaveBeenCalled()
  })

  it.each(['ENOENT', 'EACCES'])('uses gdbus if dbus-send cannot spawn (%s)', async (code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess.mockImplementation(({ program }) =>
      program === 'dbus-send'
        ? Promise.reject(Object.assign(new Error('Cannot spawn'), { code }))
        : Promise.resolve({ code: program === 'gdbus' ? 0 : 1 })
    )
    await expect(confirmDisplay(new Notification())).resolves.toBe(true)
  })

  it.each([{ code: 1 }, { code: null, timedOut: true }])(
    'does not use a fallback after a D-Bus call fails (%j)',
    async (failure) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      runProcess.mockImplementation(({ program }) =>
        Promise.resolve(program === 'dbus-send' ? failure : { code: 0 })
      )
      await expect(confirmDisplay(new Notification())).resolves.toBe(false)
    }
  )

  it('uses only the remaining activation budget after a spawn error', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const primary = Promise.withResolvers<never>()
    runProcess
      .mockReturnValueOnce(primary.promise)
      .mockResolvedValue({ code: null, timedOut: true })
    const delivered = confirmDisplay(new Notification())
    await vi.advanceTimersByTimeAsync(1_500)
    primary.reject(Object.assign(new Error('Cannot spawn'), { code: 'ENOENT' }))
    await expect(delivered).resolves.toBe(false)
    expect(runProcess).toHaveBeenLastCalledWith(
      expect.objectContaining({ program: 'gdbus', timeoutMs: 500 })
    )
  })

  it('gives Electron its full confirmation window after cold activation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const activation = Promise.withResolvers<{ code: number }>()
    runProcess.mockReturnValue(activation.promise)
    const show = vi.spyOn(Notification.prototype, 'show').mockImplementation(() => {})

    const result = dispatch()
    await vi.advanceTimersByTimeAsync(1_800)
    activation.resolve({ code: 0 })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(show).toHaveBeenCalled()
    native.latest?.emit('show')
    await expect(result).resolves.toEqual({ delivered: true })
    native.latest?.emit('close', { reason: 'applicationHidden' })
  })

  it('releases a notification closed during activation without showing it later', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const activation = Promise.withResolvers<{ code: number }>()
    runProcess.mockReturnValue(activation.promise)
    const result = dispatch()
    const pending = native.latest
    const displayed = vi.fn()
    pending?.on('show', displayed)
    pending?.emit('close', { reason: 'applicationHidden' })
    await expect(result).resolves.toEqual({ delivered: false, reason: 'not-displayed' })
    const successor = confirmDisplay(new Notification())
    activation.resolve({ code: 0 })
    await expect(successor).resolves.toBe(true)
    expect(displayed).not.toHaveBeenCalled()
  })

  it('expires an unconfirmed native show without calling native close', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.useFakeTimers()
    runProcess.mockResolvedValue({ code: 0 })
    vi.spyOn(Notification.prototype, 'show').mockImplementation(() => {})
    const close = vi.spyOn(Notification.prototype, 'close')
    const result = dispatch()

    await vi.advanceTimersByTimeAsync(2_500)
    await expect(result).resolves.toEqual({ delivered: false, reason: 'not-displayed' })
    expect(close).not.toHaveBeenCalled()
    expect(native.latest?.eventNames()).toEqual([])
  })

  it('still delivers on portable Linux installs without probe commands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess.mockRejectedValue(
      Object.assign(new Error('Executable unavailable'), { code: 'ENOENT' })
    )
    const notification = new Notification()
    const delivered = confirmDisplay(notification)
    await expect(delivered).resolves.toBe(true)
  })
})
