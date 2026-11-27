import {
  HOST_LIST_TARGET,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../../host-screen/catalog/host-list-queries'
import { useHostQuery } from '../../query/host-query'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

/**
 * The host list's workspace catalog as cached, never fetched: a session's first paint must not wait
 * behind worktree.ps. Each reader subscribes on its own, so a catalog change redraws only it.
 */
export function useCachedHostWorktrees(hostId: string): readonly Worktree[] | undefined {
  const { data } = useHostQuery(
    hostWorktreeCatalogQuery,
    { hostId, client: null },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { enabled: false }
  )
  return data?.worktrees
}
