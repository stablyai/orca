import { createElement } from 'react'
import { projectMountedScreen, renderedElementProps, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'
const WORKTREE = 'wt-files'

// Expose context to run the real client acquire/subscribe/release lifecycle over the scripted connection.
export const fileExplorerScreenMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

export function fileExplorerScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'files.explorer-screen': ({ client, effect }) => {
      const Panel = modules.load<typeof import('../../../files/MobileFileExplorerPanel')>(
        'mobile/src/files/MobileFileExplorerPanel.tsx'
      ).MobileFileExplorerPanel
      const hostClientContext = loadHostClientContext(modules)
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        getKnownState: () => 'connected',
        getClientId: () => 'client-1',
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {},
        // Record reconnect intent without reaching a real socket beyond the scripted transport.
        forceReconnect: (hostId) => {
          effect('host-client.force-reconnect', { hostId })
          return Promise.resolve()
        }
      })
      const screen = screenMount(
        () =>
          createElement(
            hostClientContext.Provider,
            { value: context },
            createElement(Panel, { hostId: HOST, worktreeId: WORKTREE, name: 'orca-files' })
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
          if (name === 'blur') {
            return
          }
          throw new Error(`Unknown file explorer action: ${name}`)
        },
        state: () => ({
          ...projectMountedScreen(screen),
          // The inert list never renders rows; observe its data as the screen’s projection.
          rows: renderedElementProps(screen.tree(), 'FlatList').flatMap((props) =>
            Array.isArray(props.data)
              ? props.data.map((row: { id?: unknown }) => row?.id)
              : [props.data]
          )
        }),
        dispose: screen.unmount
      }
    }
  }
}
