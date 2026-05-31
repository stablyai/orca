export type HostRouteActionState = {
  routeAction: string | undefined
  showNewWorktree: boolean
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
