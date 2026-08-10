export type HostRouteActionState = {
  routeAction: string | undefined
  showNewWorktree: boolean
}

export function hostNewWorktreeRoute(hostId: string): `/h/${string}?action=newWorktree` {
  return `/h/${encodeURIComponent(hostId)}?action=newWorktree`
}

export function hostNewWorktreeSessionRoute(
  hostId: string,
  worktreeId: string,
  worktreeName: string
): `/h/${string}/session/${string}?${string}` {
  const params = new URLSearchParams({ name: worktreeName, created: '1' })
  return `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}?${params}`
}

export function createInitialHostRouteActionState(
  routeAction: string | undefined
): HostRouteActionState {
  return {
    routeAction,
    showNewWorktree: routeAction === 'newWorktree'
  }
}

export function resolveHostRouteActionState(
  current: HostRouteActionState,
  routeAction: string | undefined
): HostRouteActionState {
  if (current.routeAction === routeAction) {
    return current
  }
  return {
    routeAction,
    showNewWorktree: current.showNewWorktree || routeAction === 'newWorktree'
  }
}

export function setHostRouteNewWorktreeVisible(
  current: HostRouteActionState,
  showNewWorktree: boolean
): HostRouteActionState {
  if (current.showNewWorktree === showNewWorktree) {
    return current
  }
  return { ...current, showNewWorktree }
}
