import type { HostCatalogEntry } from '../transport/types'
import { isSameWorkspace, type RecentWorkspace } from '../worktree/recent-workspaces'

export type WorkspaceSwitcherHostGroup = {
  hostId: string
  hostName: string
  workspaces: RecentWorkspace[]
}

/** Every paired host, most recently used first; hosts never opened here still get a row. */
export function buildWorkspaceSwitcherGroups(
  hosts: readonly Pick<HostCatalogEntry, 'id' | 'name' | 'lastConnected'>[],
  recents: readonly RecentWorkspace[]
): WorkspaceSwitcherHostGroup[] {
  const lastUsed = (hostId: string) => recents.find((item) => item.hostId === hostId)?.openedAt ?? 0
  return [...hosts]
    .sort((a, b) => lastUsed(b.id) - lastUsed(a.id) || b.lastConnected - a.lastConnected)
    .map((host) => ({
      hostId: host.id,
      hostName: host.name,
      workspaces: recents.filter((item) => item.hostId === host.id)
    }))
}

/** The workspace a swipe flips to: the most recent one that is not on screen, on any host. */
export function previousRecentWorkspace(
  recents: readonly RecentWorkspace[],
  current: Pick<RecentWorkspace, 'hostId' | 'worktreeId'>,
  knownHostIds: ReadonlySet<string>
): RecentWorkspace | null {
  return (
    recents.find((item) => !isSameWorkspace(item, current) && knownHostIds.has(item.hostId)) ?? null
  )
}
