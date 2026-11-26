import type { AppState } from '@/store/types'

/** The user's per-worktree "Mute Notifications" choice. Unlike sidebar-filter muting, this
 *  silences only interruptions (banner, sound, push, tray dot); unread state still updates. */
export function isWorktreeNotificationDeliveryMuted(
  state: Pick<AppState, 'notificationsMutedByWorktree'>,
  workspaceId: string
): boolean {
  return state.notificationsMutedByWorktree?.[workspaceId] === true
}
