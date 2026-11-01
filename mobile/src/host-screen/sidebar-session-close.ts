import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { sessionTabsListRead } from '../session/mobile-session-read-operations'
import { sessionTabClose } from '../session/mobile-session-write-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { rpcClientForExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { sidebarSessionTabForPane, sidebarSessionTabs } from './sidebar-session-tab'

export type SidebarSessionCloseOutcome = 'closed' | 'missing' | 'refused' | 'failed'

export async function closeSidebarSession(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  paneKey: string
): Promise<SidebarSessionCloseOutcome> {
  const worktree = `id:${worktreeId}`
  let snapshot: unknown
  try {
    snapshot = sessionTabsListRead.interpret(
      await sessionTabsListRead.request(client, { worktree })
    )
  } catch {
    return 'failed'
  }
  const tabs = sidebarSessionTabs(snapshot)
  if (!tabs) {
    return 'failed'
  }
  const tab = sidebarSessionTabForPane(tabs, paneKey)
  if (!tab) {
    return 'missing'
  }
  try {
    const closed = sessionTabClose.interpret(
      await sessionTabClose.request(client, {
        worktree,
        tabId: tab.id,
        reason: 'user'
      })
    )
    if (!closed.accepted) {
      return 'failed'
    }
    return closed.value.refused ? 'refused' : 'closed'
  } catch {
    return 'failed'
  }
}

export async function closeHostSidebarSession(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  worktree: { hostId?: ExecutionHostId; worktreeId: string },
  paneKey: string
): Promise<SidebarSessionCloseOutcome> {
  if (!client) {
    return 'failed'
  }
  const rowClient = rpcClientForExecutionHost(client, hostCapabilities, worktree.hostId)
  if (!rowClient) {
    return 'failed'
  }
  return closeSidebarSession(rowClient, worktree.worktreeId, paneKey)
}
