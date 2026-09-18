import { createElement } from 'react'
import { screenMount } from '../mounted-screen-tree'
import { performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'

/** The screen-root hook reads its client through the context handle `client-context.tsx` keeps. */
export const tasksRouteScreenMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

/** The tasks screen root: the repo list its pickers and its create form are hydrated from. */
export function tasksRouteScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'tasks.route-repo-list': ({ client, effect }) => {
      const useRoute = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-route-and-item-state')
      >(
        'mobile/src/tasks/use-mobile-tasks-route-and-item-state.tsx'
      ).useMobileTasksRouteAndItemState
      const hostClientContext = loadHostClientContext(modules)
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        getKnownState: () => 'connected',
        getClientId: () => 'client-1',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => 0,
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {},
        getState: () => 'connected',
        getActivePath: () => 'lan',
        getPendingPath: () => null,
        isPairingRejected: () => false,
        isHostSignedOut: () => false
      })
      // A holder rather than a binding: Harness is a component, so it cannot assign an outer name.
      const observed: { model?: ReturnType<typeof useRoute> } = {}
      function Harness(): null {
        observed.model = useRoute()
        return null
      }
      const screen = screenMount(
        () => createElement(hostClientContext.Provider, { value: context }, createElement(Harness)),
        effect
      )
      const model = (): ReturnType<typeof useRoute> => {
        const found = observed.model
        if (!found) {
          throw new Error('The tasks route hook is not mounted')
        }
        return found
      }
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          if (name === 'ensure-repos') {
            return performHookAction(() => model().repoListEnsureLoaded())
          }
          throw new Error(`Unknown tasks route action: ${name}`)
        },
        state: () => {
          const crash = screen.crash()
          if (crash !== null) {
            return { crash }
          }
          const repos = model().repos
          return {
            crash,
            // A reply whose result carries no `repos` array is published as it arrived, so the
            // projection records what the screen holds rather than assuming a list.
            repos: Array.isArray(repos) ? repos.map((repo) => repo?.id) : repos,
            repoListStatus: model().repoList.state.status,
            repoListError: model().repoList.state.error
          }
        },
        dispose: screen.unmount
      }
    }
  }
}
