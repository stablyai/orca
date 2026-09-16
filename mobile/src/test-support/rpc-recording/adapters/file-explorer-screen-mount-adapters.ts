import { createElement, type Context } from 'react'
import { projectMountedScreen, renderedElementProps, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'
const WORKTREE = 'wt-files'

/**
 * The panel reads its client through the shared host-client context, whose handle is module-private
 * in `client-context.tsx`. Exposing it mounts the real `useHostClient` — acquire, subscribe,
 * release — over a scripted client, instead of reconstructing the hook against a prop.
 */
export const fileExplorerScreenMountExposures: readonly OperationExposure[] = [
  ['client-context.tsx', '\nexports.recorderHostClientContext = Ctx;']
]

/** The mobile files tab: the directory read, and the capped legacy list it falls back to. */
export function fileExplorerScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'files.explorer-screen': ({ client, effect }) => {
      const Panel = modules.load<typeof import('../../../files/MobileFileExplorerPanel')>(
        'mobile/src/files/MobileFileExplorerPanel.tsx'
      ).MobileFileExplorerPanel
      const { recorderHostClientContext } = modules.load<{
        recorderHostClientContext: Context<RpcClientContextValue | null>
      }>('mobile/src/transport/client-context.tsx')
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        getKnownState: () => 'connected',
        getClientId: () => 'client-1',
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {},
        // A reconnect is the screen reaching past the socket the recording scripts, so it is
        // recorded rather than performed.
        forceReconnect: (hostId) => {
          effect('host-client.force-reconnect', { hostId })
          return Promise.resolve()
        }
      })
      const screen = screenMount(
        () =>
          createElement(
            recorderHostClientContext.Provider,
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
          // The inert list never calls `renderItem`, so the rows it was handed are the only
          // record of what the screen would have drawn.
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
