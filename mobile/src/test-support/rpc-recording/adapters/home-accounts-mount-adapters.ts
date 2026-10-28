import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

// Load the decoder through AccountUsage so recordings verify the screen module works under the mount loader.
export function homeAccountsMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'home.host-accounts': (context) => {
      const fetchAccounts = modules.load<typeof import('../../../home/mobile-home-host-requests')>(
        'mobile/src/home/mobile-home-host-requests.ts'
      ).fetchMobileHomeAccounts
      let snapshots: Record<string, unknown> = {}
      let disposed = false
      return {
        action(name) {
          if (name === 'unmount') {
            disposed = true
            return
          }
          if (name !== 'load') {
            throw new Error(`Unknown home accounts action: ${name}`)
          }
          return fetchAccounts(
            context.client,
            HOST,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder observes the published map as data, not as a decoded snapshot.
            ((update: (value: Record<string, unknown>) => Record<string, unknown>) => {
              snapshots = update(snapshots)
              context.effect('accounts', snapshots)
            }) as Parameters<typeof fetchAccounts>[2],
            () => disposed
          )
        },
        state: () => ({ ...snapshots }),
        dispose: () => {
          disposed = true
        }
      }
    }
  }
}
