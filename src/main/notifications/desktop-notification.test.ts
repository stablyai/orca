import { Notification } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForNotificationDisplay } from '../ipc/notifications/native-notification-lifecycle'
import { closeDesktopNotification, showDesktopNotification } from './desktop-notification'

const runProcess = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Notification: class extends EventEmitter {
      show() {
        this.emit('show')
      }
      close() {
        this.emit('close', {})
      }
    }
  }
})

describe('Linux desktop notification admission', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    runProcess.mockReset()
  })

  it('reports failed activation as undelivered and retries when the notification service recovers', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess.mockResolvedValueOnce({ code: 1 }).mockResolvedValueOnce({ code: 0 })
    const duringOutage = new Notification()
    const undelivered = waitForNotificationDisplay(duringOutage)
    showDesktopNotification(duringOutage)
    await expect(undelivered).resolves.toBe(false)

    const afterRecovery = new Notification()
    const delivered = waitForNotificationDisplay(afterRecovery)
    showDesktopNotification(afterRecovery)
    await expect(delivered).resolves.toBe(true)
  })

  it('discards a pending notification when a replacement arrives during activation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const activation = Promise.withResolvers<{ code: number }>()
    runProcess.mockReturnValue(activation.promise)

    const previous = new Notification()
    const replaced = waitForNotificationDisplay(previous)
    const displayed = vi.fn()
    previous.on('show', displayed)
    showDesktopNotification(previous)
    closeDesktopNotification(previous)

    const successor = new Notification()
    const delivered = waitForNotificationDisplay(successor)
    showDesktopNotification(successor)
    activation.resolve({ code: 0 })
    await expect(replaced).resolves.toBe(false)
    await expect(delivered).resolves.toBe(true)
    expect(displayed).not.toHaveBeenCalled()
  })

  it('uses the D-Bus fallback when GLib tools are absent', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess
      .mockRejectedValueOnce(Object.assign(new Error('Executable unavailable'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ code: 1 })
    const notification = new Notification()
    const delivered = waitForNotificationDisplay(notification)
    showDesktopNotification(notification)
    await expect(delivered).resolves.toBe(false)
  })

  it('still delivers on portable Linux installs without probe commands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    runProcess.mockRejectedValue(
      Object.assign(new Error('Executable unavailable'), { code: 'ENOENT' })
    )
    const notification = new Notification()
    const delivered = waitForNotificationDisplay(notification)
    showDesktopNotification(notification)
    await expect(delivered).resolves.toBe(true)
  })
})
