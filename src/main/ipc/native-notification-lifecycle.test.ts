import { EventEmitter } from 'node:events'
import { Notification } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeNotifications,
  retainNotificationUntilRelease
} from './native-notification-lifecycle'

vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    close = vi.fn()
  }
}))

const platform = process.platform
const releases: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  Object.defineProperty(process, 'platform', { value: platform })
  vi.useRealTimers()
})

function retain() {
  const notification = new Notification({ title: 'Agent finished' })
  const onRelease = vi.fn()
  const release = retainNotificationUntilRelease(notification, onRelease)
  releases.push(release)
  return { notification, release, onRelease }
}

describe.each(['win32', 'linux'] as const)(
  '%s notification history lifetime',
  (historyPlatform) => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: historyPlatform })
    })

    it('keeps history clicks working after the banner times out', () => {
      const { notification, release, onRelease } = retain()
      const navigate = vi.fn(() => release())
      notification.on('click', navigate)

      if (historyPlatform === 'win32') {
        notification.emit('close', { reason: 'timedOut' })
      }
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)

      expect(onRelease).not.toHaveBeenCalled()
      notification.emit('click')
      expect(navigate).toHaveBeenCalledOnce()
      expect(onRelease).toHaveBeenCalledOnce()
      expect(activeNotifications.has(notification)).toBe(false)
    })
    it('closes and releases the oldest notification past the retention limit', () => {
      const first = retain()
      for (let index = 0; index < 256; index++) {
        retain()
      }
      expect(first.notification.close).toHaveBeenCalledOnce()
      expect(first.onRelease).toHaveBeenCalledOnce()
      expect(activeNotifications.size).toBe(256)
    })

    it('releases a notification removed by the user', () => {
      const { notification, onRelease } = retain()

      notification.emit(
        'close',
        historyPlatform === 'win32' ? { reason: 'userCanceled' } : undefined
      )

      expect(onRelease).toHaveBeenCalledOnce()
      expect(activeNotifications.has(notification)).toBe(false)
    })
  }
)
