import { AppState } from 'react-native'

// `executionHost` is the route's server; absent for the desktop's own workspaces.
let viewing: { hostId: string; worktreeId: string; executionHost?: string } | null = null
export function setNotificationViewingWorkspace(value: typeof viewing): void {
  viewing = value
}

export function shouldSuppressNotificationWhileViewing(
  event: { worktreeId?: string; executionHost?: string },
  hostId: string,
  suppressWhileViewing: boolean
): boolean {
  return (
    suppressWhileViewing &&
    AppState.currentState === 'active' &&
    viewing?.hostId === hostId &&
    viewing.worktreeId === event.worktreeId &&
    viewing.executionHost === event.executionHost
  )
}
