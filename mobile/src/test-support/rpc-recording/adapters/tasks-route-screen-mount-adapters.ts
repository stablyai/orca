import type * as HostProtocolGatesContext from '../../../components/host-protocol-gates-context'
import { createElement } from 'react'
import { screenMount } from '../mounted-screen-tree'
import { performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'
import type { HostStatusGates } from '../../../transport/host-status-gates'

const HOST = 'host-1'

export const tasksRouteScreenMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

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
      // The screen sits under the host route's protocol gate; this one advertises no capabilities.
      const gatesContext = modules.load<typeof HostProtocolGatesContext>(
        'mobile/src/components/host-protocol-gates-context.ts'
      ).HostStatusGatesContext
      const gates: HostStatusGates = {
        hostCapabilities: [],
        floatingWorkspaceEnabled: false,
        desktopAppVersion: null,
        compatVerdict: { kind: 'ok' },
        hostProtocolWindow: { protocolVersion: undefined, minCompatibleMobileVersion: undefined },
        statusPending: false,
        statusReadable: true
      }
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
        getRelayHostReachability: () => 'connecting'
      })
      // Use a holder because the component cannot assign an external bare binding.
      const observed: { model?: ReturnType<typeof useRoute> } = {}
      function Harness(): null {
        observed.model = useRoute()
        return null
      }
      const screen = screenMount(
        () =>
          createElement(
            hostClientContext.Provider,
            { value: context },
            createElement(gatesContext.Provider, { value: gates }, createElement(Harness))
          ),
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
            // Preserve malformed non-array repos in observations instead of normalizing away the screen’s state.
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
