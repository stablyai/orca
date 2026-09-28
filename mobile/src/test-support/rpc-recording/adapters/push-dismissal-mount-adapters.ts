import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

/**
 * Reconciling the OS notification tray with the host. Everything this reads off the device is
 * declared by the scenario — the presented notifications, and the stored host list the push
 * fingerprint is resolved against — so the identities it puts on the wire are scenario bytes.
 */
export function pushDismissalMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'notifications.push-dismissal': ({ client }) => {
      const requestNotificationCatchup = modules.load<
        typeof import('../../../notifications/push-dismissal-reconciliation')
      >('mobile/src/notifications/push-dismissal-reconciliation.ts').requestNotificationCatchup
      let disposed = false
      return {
        action(name) {
          if (name === 'catchup') {
            return requestNotificationCatchup(client, HOST, () => disposed)
          }
          if (name === 'unmount') {
            disposed = true
            return
          }
          throw new Error(`Unknown push dismissal action: ${name}`)
        },
        state: () => ({ disposed }),
        dispose: () => {
          disposed = true
        }
      }
    }
  }
}
