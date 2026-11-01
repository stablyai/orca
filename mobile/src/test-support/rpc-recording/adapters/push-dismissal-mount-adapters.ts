import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

// Declare device tray/host catalog in the scenario so reconciliation emits identities from test inputs, not adapter guesses.
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
