import type { AppState } from '@/store/types'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'

/** The user's per-worktree "Mute Notifications" choice. Unlike sidebar-filter muting, this
 *  silences only interruptions (banner, sound, push, tray dot); unread state still updates. */
export function isWorktreeNotificationDeliveryMuted(
  state: Pick<AppState, 'notificationsMutedByWorktree'>,
  workspaceId: string
): boolean {
  return state.notificationsMutedByWorktree?.[workspaceId] === true
}

/** The user's per-tab "Mute Notifications" choice. Matches worktree mute semantics:
 *  silences interruptions (banner, sound, push, tray dot) while unread state still updates. */
export function isTabNotificationDeliveryMuted(
  state: Pick<AppState, 'notificationsMutedByTabId'>,
  tabId: string | null | undefined
): boolean {
  return Boolean(tabId && state.notificationsMutedByTabId?.[tabId] === true)
}

/** Extracts the owning tab id from a terminal notification pane key (`${tabId}:${leafId}`). */
export function resolveTerminalNotificationTabId(paneKey: string | undefined): string | null {
  if (!paneKey) {
    return null
  }
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}
