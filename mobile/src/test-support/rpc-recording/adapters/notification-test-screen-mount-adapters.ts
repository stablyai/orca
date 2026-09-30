import { createElement } from 'react'
import { performHookAction } from '../hook-mount'
import { projectMountedScreen, renderedElementProps, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'

/**
 * `useAllHostClients` reads the shared context through the module-private handle in
 * `client-context.tsx`, so exposing it mounts the real acquire/release cycle over a scripted client.
 */
export const notificationTestScreenMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

/** The settings push probe: one `notifications.testPush` per connected desktop. */
export function notificationTestScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'notifications.display-test-screen': ({ client, effect }) => {
      const Probe = modules.load<typeof import('../../../settings/notification-display-test')>(
        'mobile/src/settings/notification-display-test.tsx'
      ).NotificationDisplayTest
      const hostClientContext = loadHostClientContext(modules)
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        closeIfUnused: () => {},
        releaseAndCloseIfUnused: () => {},
        getState: () => 'connected',
        getActivePath: () => 'lan',
        getPendingPath: () => null,
        isPairingRejected: () => false,
        getRelayHostReachability: () => 'connecting',
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {},
        subscribeAllHosts: () => () => {}
      })
      const screen = screenMount(
        () =>
          createElement(
            hostClientContext.Provider,
            { value: context },
            createElement(Probe, { onTroubleshoot: () => effect('screen.troubleshoot', {}) })
          ),
        effect
      )
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          if (name === 'send-test') {
            // An inert Pressable never fires, so the scripted press is the adapter reading back the
            // handler the screen rendered and calling it.
            const button = renderedElementProps(screen.tree(), 'Pressable').find(
              (props) => props.accessibilityRole === 'button'
            )
            const press = button?.onPress
            if (typeof press !== 'function') {
              throw new Error('The probe rendered no send button to press')
            }
            return performHookAction(() => press())
          }
          throw new Error(`Unknown notification test action: ${name}`)
        },
        state: () => projectMountedScreen(screen),
        dispose: screen.unmount
      }
    }
  }
}
