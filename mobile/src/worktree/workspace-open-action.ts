import type { Worktree } from './workspace-list-sections'

type WorkspaceOpenItem = Pick<Worktree, 'worktreeId' | 'displayName' | 'repo'>

export type WorkspaceOpenActions = {
  navigate: (target: string) => boolean
  markOptimisticActive: (worktreeId: string) => void
  activateWorktree?: (worktreeId: string) => void
}

export function buildWorkspaceSessionPath(hostId: string, item: WorkspaceOpenItem): string {
  const name = item.displayName || item.repo
  return `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(name)}`
}

export function openWorkspaceSession(
  hostId: string,
  item: WorkspaceOpenItem,
  actions: WorkspaceOpenActions
): string {
  const target = buildWorkspaceSessionPath(hostId, item)
  actions.navigate(target)
  actions.markOptimisticActive(item.worktreeId)
  actions.activateWorktree?.(item.worktreeId)
  return target
}
