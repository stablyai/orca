import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

/**
 * The desktop notification socket: one subscribe, the catch-up read its `ready` arms, the tray
 * dismissals its events drive, and the server unsubscribe the transport sends once it is disposed.
 *
 * The disposer is the whole output — it is what a host connection calls when the client goes away —
 * so the recording drives `start` and `stop` and observes what each put on the wire. Everything the
 * reconciliation reads off the device is declared by the scenario, the way
 * `push-dismissal-mount-adapters.ts` declares it, so the identities that reach the host are
 * scenario bytes.
 */
export function desktopNotificationStreamMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'notifications.desktop-stream': ({ client }) => {
      const subscribeToDesktopNotifications = modules.load<
        typeof import('../../../notifications/mobile-notifications')
      >('mobile/src/notifications/mobile-notifications.ts').subscribeToDesktopNotifications
      let stop: (() => void) | null = null
      return {
        action(name) {
          if (name === 'start') {
            stop = subscribeToDesktopNotifications(client, HOST)
            return
          }
          if (name === 'stop') {
            stop?.()
            stop = null
            return
          }
          throw new Error(`Unknown desktop notification stream action: ${name}`)
        },
        state: () => ({ running: stop !== null }),
        dispose: () => {
          stop?.()
          stop = null
        }
      }
    }
  }
}
