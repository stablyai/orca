import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { ListRow } from '../../components/list/ListGroup'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { workspaceRouteExecutionHost } from '../../worktree/execution-host-scoped-rpc-client'
import type { Worktree } from '../../worktree/workspace-list-types'
import { formatBranchLabel } from '../mobile-source-control-screen-state'
import { useFolderWorktreeStatus } from './use-folder-worktree-status'

type Props = {
  hostId: string
  /** The paired desktop's, which decide whether it relays to the row's server. */
  desktopCapabilities: readonly string[]
  worktree: Worktree
  /** The desktop relays to the row's server but can't reach it (e.g. it needs an update). */
  unreachable: boolean
  subscribed: boolean
  refreshers: Set<() => void>
  onOpen: () => void
}

/** One attached worktree: desktop's card header (repo, name, branch, ahead/behind, change count); tapping opens its Source Control. */
export function MobileFolderWorktreeRow({
  hostId,
  desktopCapabilities,
  worktree,
  unreachable,
  subscribed,
  refreshers,
  onOpen
}: Props) {
  const t = useMobileTranslation()
  const { client, state } = useHostClient(hostId)
  // A relayed server's row reads through the desktop, as its own Source Control does.
  const routeHost = workspaceRouteExecutionHost(client, desktopCapabilities, worktree.hostId)
  const openable = routeHost !== null && !unreachable
  const status = useFolderWorktreeStatus({
    hostId,
    client: state === 'connected' && openable ? client : null,
    routeHost: routeHost ?? undefined,
    worktreeId: worktree.worktreeId,
    subscribed,
    refreshers
  })

  const read = status.data?.kind === 'ready' ? status.data.status : undefined
  // A failed or unsupported read must not look like a clean worktree.
  const unread = status.data?.kind === 'unavailable' || (!read && status.error !== null)
  const branch = read
    ? formatBranchLabel(read.branch, read.head)
    : worktree.branch.replace(/^refs\/heads\//, '')
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
      value={
        !openable || unread
          ? t('sourceControl.folder.statusUnavailable', 'Unavailable')
          : changeCount > 0
            ? String(changeCount)
            : undefined
      }
      navigates={openable}
      disabled={!openable}
      onPress={onOpen}
    />
  )
}
