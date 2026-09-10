import { AppState } from 'react-native'

let viewing: { hostId: string; worktreeId: string } | null = null
export function setNotificationViewingWorkspace(value: typeof viewing): void {
  viewing = value
}

export function shouldSuppressNotificationWhileViewing(
  event: { worktreeId?: string },
  hostId: string,
  suppressWhileViewing: boolean
): boolean {
  return (
    suppressWhileViewing &&
    AppState.currentState === 'active' &&
    viewing?.hostId === hostId &&
    viewing.worktreeId === event.worktreeId
  )
}
