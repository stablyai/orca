import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { MountAdapter, MountContext } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST_ID = 'host-1'
const WORKTREE_ID = 'worktree-1'
const CLIENT_ID = 'device-token-1'
// Hoist list identities so the load effect cannot rerun on every render.
const WORKTREES = [
  { worktreeId: WORKTREE_ID, path: '/repo/feature', repoId: 'repo-1' },
  { worktreeId: 'worktree-2', path: '/repo/sibling', repoId: 'repo-1' }
]
const UNLOADED_WORKTREES: typeof WORKTREES = []

// Expose the real context provider so recordings observe acquisition/reconnect policy rather than reimplementing useHostClient.
export const agentHistoryMountExposures: readonly OperationExposure[] = [hostClientContextExposure]

function hostClientContext(
  client: MountContext['client'],
  effect: MountContext['effect']
): RpcClientContextValue {
  return {
    acquire: () => client,
    release: () => {},
    releaseAndCloseIfUnused: () => {},
    closeIfUnused: () => {},
    forceReconnect: () => {
      effect('force-reconnect', { hostId: HOST_ID })
      return Promise.resolve()
    },
    refreshHostClient: () => {},
    forgetHostClient: () => {},
    disconnectHostClient: () => {},
    getState: () => 'connected',
    getKnownState: () => 'connected',
    getClientId: () => CLIENT_ID,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    getActivePath: () => 'lan',
    getPendingPath: () => null,
    isPairingRejected: () => false,
    getRelayHostReachability: () => 'connecting',
    subscribeHostState: () => () => {},
    getAllClients: () => [{ hostId: HOST_ID, client }],
    subscribeAllHosts: () => () => {},
    primeHosts: () => {}
  }
}

export function agentHistoryMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'aiVault.history-scan': ({ client, effect }) => {
      const useHistory = modules.load<
        typeof import('../../../agent-history/use-mobile-agent-history-state')
      >('mobile/src/agent-history/use-mobile-agent-history-state.ts').useMobileAgentHistoryState
      const RecordingHostClientContext = loadHostClientContext(modules)
      const context = hostClientContext(client, effect)
      // Use a holder because the component cannot assign an external bare binding.
      const observed: { history?: ReturnType<typeof useHistory> } = {}
      let worktrees = WORKTREES
      let worktreesLoaded = true
      let renderer: ReactTestRenderer | undefined
      function Harness() {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook and its scope derivation read only these three worktree fields.
        const params = {
          hostId: HOST_ID,
          worktreeId: WORKTREE_ID,
          worktrees,
          worktreesLoaded
        } as unknown as Parameters<typeof useHistory>[0]
        observed.history = useHistory(params)
        return null
      }
      const element = () =>
        createElement(
          RecordingHostClientContext.Provider,
          { value: context },
          createElement(Harness)
        )
      return {
        action(name, args) {
          if (name === 'mount') {
            if (args.worktreesLoaded === false) {
              worktrees = UNLOADED_WORKTREES
              worktreesLoaded = false
            }
            act(() => {
              renderer = create(element())
            })
            return
          }
          if (name === 'worktrees-loaded') {
            worktrees = WORKTREES
            worktreesLoaded = true
            act(() => renderer?.update(element()))
            return
          }
          throw new Error(`Unknown agent history action: ${name}`)
        },
        state: () => ({
          scope: observed.history!.scope,
          screenState: observed.history!.screenState,
          refreshing: observed.history!.refreshing,
          hostStatusResult: observed.history!.hostStatusResult,
          activeWorktreePath: observed.history!.activeWorktreePath
        }),
        dispose() {
          act(() => {
            renderer?.unmount()
            renderer = undefined
          })
        }
      }
    }
  }
}
