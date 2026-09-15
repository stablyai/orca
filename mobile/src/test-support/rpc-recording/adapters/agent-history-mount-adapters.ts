import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { OperationExposure } from '../operation-module-loader'
import type { MountAdapter, MountContext } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const HOST_ID = 'host-1'
const WORKTREE_ID = 'worktree-1'
const CLIENT_ID = 'device-token-1'
// Hoisted: the hook's load effect keys on this list's identity, so a fresh array each render loops.
const WORKTREES = [
  { worktreeId: WORKTREE_ID, path: '/repo/feature', repoId: 'repo-1' },
  { worktreeId: 'worktree-2', path: '/repo/sibling', repoId: 'repo-1' }
]
/** Hoisted for the same reason, and empty because an unloaded list has nothing in it yet. */
const UNLOADED_WORKTREES: typeof WORKTREES = []

/**
 * The history hook reaches its client through the shared per-host context rather than a parameter,
 * so the context object is the mounting boundary. Exposing the provider is what lets the real hook
 * run against the scripted client; reimplementing `useHostClient` would put acquisition and
 * connection-state policy in the adapter, which is exactly what these recordings exist to observe.
 */
export const agentHistoryMountExposures: readonly OperationExposure[] = [
  ['transport/client-context.tsx', '\nexports.RecordingHostClientContext = Ctx;']
]

/** A connected single-host context: one client, one state, no acquisition or reconnect behaviour. */
function hostClientContext(client: MountContext['client'], effect: MountContext['effect']) {
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
    isHostSignedOut: () => false,
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
      const { RecordingHostClientContext } = modules.load<{
        RecordingHostClientContext: React.Context<unknown>
      }>('mobile/src/transport/client-context.tsx')
      const context = hostClientContext(client, effect)
      // A holder rather than a bare binding: the harness is a component, and a component may not
      // assign a variable declared outside it.
      const observed: { history?: ReturnType<typeof useHistory> } = {}
      // The list and the flag move together, because the screen learns both from the same fetch.
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
