import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

// Drive start/stop and scenario-declared device identity so subscribe, catch-up and unsubscribe bytes come from product reconciliation.
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
