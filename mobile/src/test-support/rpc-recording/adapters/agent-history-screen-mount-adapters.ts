import { createElement, type Context } from 'react'
import { projectMountedScreen, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'
const WORKTREE = 'wt-history'

/** The panel reads its client through the shared context, whose handle is module-private. */
export const agentHistoryScreenMountExposures: readonly OperationExposure[] = [
  ['client-context.tsx', '\nexports.recorderHostClientContext = Ctx;']
]

/** The agent history screen: the worktree list that seeds its scopes, then the session scan. */
export function agentHistoryScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'aiVault.history-screen': ({ client, effect }) => {
      const Panel = modules.load<
        typeof import('../../../agent-history/MobileAgentSessionHistoryPanel')
      >(
        'mobile/src/agent-history/MobileAgentSessionHistoryPanel.tsx'
      ).MobileAgentSessionHistoryPanel
      const { recorderHostClientContext } = modules.load<{
        recorderHostClientContext: Context<RpcClientContextValue | null>
      }>('mobile/src/transport/client-context.tsx')
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        getKnownState: () => 'connected',
        getClientId: () => 'client-1',
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {}
      })
      const screen = screenMount(
        () =>
          createElement(
            recorderHostClientContext.Provider,
            { value: context },
            createElement(Panel, { hostId: HOST, worktreeId: WORKTREE, name: 'orca-history' })
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
          throw new Error(`Unknown agent history screen action: ${name}`)
        },
        state: () => projectMountedScreen(screen),
        dispose: screen.unmount
      }
    }
  }
}
