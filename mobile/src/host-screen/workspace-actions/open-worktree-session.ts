import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../src/shared/sidebar-list/feed/sidebar-inputs-switch'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { serverUpdateNeededNotice } from '../../host-route-notice'
import { workspaceRouteExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import type { ServerWorkspaces } from '../../worktree/execution-hosts/server-workspaces'
import { noteLastVisitedWorktree } from '../../worktree/navigation/last-visited-worktree-by-host'
import {
  getWorktreeRowIdentity,
  isSameWorktreeRow
} from '../../worktree/row-presentation/worktree-host-row-identity'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { worktreeActivate } from '../host-screen-operations'
import { agentPaneHomeLoaded, homeWorktreeForAgentPane } from '../agent-pane-home-worktree'

type SessionRow = Pick<Worktree, 'worktreeId' | 'hostId' | 'displayName' | 'repo'>

/** Opens a workspace row, following a pane to the workspace that actually runs it. */
export function openHostWorktreeSession(args: {
  client: RpcClient | null
  clientForRow: (item: Pick<Worktree, 'hostId'>) => RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  hostId: string | undefined
  item: SessionRow
  navigateFromHostList: (target: string, selectPane?: boolean, beforeNavigate?: () => void) => void
  paneKey?: string
  serverWorkspaces: ServerWorkspaces
  setOptimisticActiveWorktreeIdentity: (identity: string) => void
  setServerNotice: (notice: string) => void
  worktrees: readonly Worktree[]
}): void {
  const { item, paneKey } = args
  const allWorktrees = [...args.worktrees, ...args.serverWorkspaces.worktrees]
  const listed = allWorktrees.find((worktree) => isSameWorktreeRow(worktree, item))
  const home =
    paneKey && listed ? homeWorktreeForAgentPane(allWorktrees, paneKey, listed) : (listed ?? item)
  // Never open the coordinator's mirrored copy while the stamped home card is still loading.
  if (paneKey && !agentPaneHomeLoaded(allWorktrees, paneKey, home)) {
    return
  }
  const server = args.serverWorkspaces.hosts.find((host) => host.hostId === home.hostId)
  if (server?.relay === 'update-needed') {
    args.setServerNotice(serverUpdateNeededNotice(server.label))
    return
  }
  const routeHost = workspaceRouteExecutionHost(args.client, args.hostCapabilities, home.hostId)
  if (routeHost === null) {
    return
  }
  // Use an empty missing hostId: the shell refuses /h//session, whereas the string undefined would name an accepted host.
  const executionHost = routeHost ? `&executionHost=${encodeURIComponent(routeHost)}` : ''
  const pane = paneKey ? `&paneKey=${encodeURIComponent(paneKey)}` : ''
  const target = `/h/${encodeURIComponent(args.hostId ?? '')}/session/${encodeURIComponent(home.worktreeId)}?name=${encodeURIComponent(home.displayName || home.repo)}${executionHost}${pane}`
  args.navigateFromHostList(target, Boolean(paneKey), () => {
    // Record this phone’s visit before navigation; a session opened in another page cannot publish its stored write back here.
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
      args.setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(home))
    } else if (args.hostId) {
      noteLastVisitedWorktree({
        hostId: args.hostId,
        worktreeId: home.worktreeId,
        executionHost: routeHost
      })
    }
    const rowClient = args.clientForRow(home)
    if (rowClient && args.connState === 'connected') {
      void worktreeActivate
        .request(rowClient, {
          worktree: `id:${home.worktreeId}`,
          notifyClients: false,
          navigation: 'caller'
        })
        .catch(() => null)
    }
  })
}
