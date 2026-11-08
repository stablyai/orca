import { useEffect } from 'react'
import { ListRow } from '../../components/list/ListGroup'
import { useHostQuery } from '../../query/host-query'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from '../../worktree/execution-host-scoped-rpc-client'
import type { Worktree } from '../../worktree/workspace-list-types'
import { gitStatusQuery } from '../mobile-git-status-query'
import { formatBranchLabel } from '../mobile-source-control-screen-state'

const NO_INPUT = {}

type Props = {
  hostId: string
  /** The paired desktop's, which decide whether it relays to the row's server. */
  desktopCapabilities: readonly string[]
  worktree: Worktree
  subscribed: boolean
  refreshers: Set<() => void>
  onOpen: () => void
}

/** One attached worktree: desktop's card header (repo, name, branch, ahead/behind, change count); tapping opens its Source Control. */
export function MobileFolderWorktreeRow({
  hostId,
  desktopCapabilities,
  worktree,
  subscribed,
  refreshers,
  onOpen
}: Props) {
  const { client, state } = useHostClient(hostId)
  // A relayed server's row reads through the desktop, as its own Source Control does.
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, worktree.hostId)
  const rowClient =
    client && state === 'connected' && routeHost !== null
      ? routeHost
        ? scopeRpcClientToExecutionHost(client, routeHost)
        : client
      : null
  const status = useHostQuery(
    gitStatusQuery,
    { hostId, client: rowClient },
    { exec: routeHost ?? 'local', worktree: worktree.worktreeId },
    NO_INPUT,
    { subscribed }
  )
  const refetch = status.refetch
  useEffect(() => {
    const refresh = () => void refetch()
    refreshers.add(refresh)
    return () => {
      refreshers.delete(refresh)
    }
  }, [refetch, refreshers])

  const read = status.data?.kind === 'ready' ? status.data.status : undefined
  const branch = read ? formatBranchLabel(read.branch, read.head) : worktree.branch
  const ahead = read?.upstreamStatus?.ahead ?? 0
  const behind = read?.upstreamStatus?.behind ?? 0
  const changeCount = read?.entries.length ?? 0
  const subtitle = [
    // Same-repo worktrees are told apart by name, as desktop does.
    worktree.displayName && worktree.displayName !== branch ? worktree.displayName : null,
    branch || null,
    ahead > 0 ? `↑${ahead}` : null,
    behind > 0 ? `↓${behind}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ListRow
      title={worktree.repo}
      subtitle={subtitle}
      value={changeCount > 0 ? String(changeCount) : undefined}
      navigates
      onPress={onOpen}
    />
  )
}
