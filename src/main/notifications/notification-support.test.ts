import { describe, expect, it } from 'vitest'
import { isDesktopNotificationSupported } from './notification-support'

describe('isDesktopNotificationSupported', () => {
  it('returns false when electron Notification.isSupported returns false', () => {
    expect(
      isDesktopNotificationSupported({
        isNotificationSupported: () => false,
        platform: 'darwin'
      })
    ).toBe(false)
  })

  it('returns true on non-linux platforms when Notification.isSupported is true', () => {
    expect(
      isDesktopNotificationSupported({
        isNotificationSupported: () => true,
        platform: 'darwin'
      })
    ).toBe(true)

    expect(
      isDesktopNotificationSupported({
        isNotificationSupported: () => true,
        platform: 'win32'
      })
    ).toBe(true)
  })

  describe('on linux', () => {
    it('returns true when DBUS_SESSION_BUS_ADDRESS is present', () => {
      expect(
        isDesktopNotificationSupported({
          isNotificationSupported: () => true,
          platform: 'linux',
          env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
        })
      ).toBe(true)
    })

    it('returns true when XDG_RUNTIME_DIR/bus socket exists', () => {
      expect(
        isDesktopNotificationSupported({
          isNotificationSupported: () => true,
          platform: 'linux',
          env: { XDG_RUNTIME_DIR: '/run/user/1000' },
          busSocketExists: (p) => p === '/run/user/1000/bus'
        })
      ).toBe(true)
    })

    it('returns false on headless linux when DBUS_SESSION_BUS_ADDRESS is unset and XDG_RUNTIME_DIR has no bus socket', () => {
      expect(
        isDesktopNotificationSupported({
          isNotificationSupported: () => true,
          platform: 'linux',
          env: { XDG_RUNTIME_DIR: '/run/user/1000' },
          busSocketExists: () => false
        })
      ).toBe(false)
    })

    it('returns false on headless linux when neither DBUS_SESSION_BUS_ADDRESS nor XDG_RUNTIME_DIR is set', () => {
      expect(
        isDesktopNotificationSupported({
          isNotificationSupported: () => true,
          platform: 'linux',
          env: {}
        })
      ).toBe(false)
    })
  })
})
