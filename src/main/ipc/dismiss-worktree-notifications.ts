import { sessionAnnouncedNotifications } from '../notifications/announced-notification-registry'
import { removeReadMacosNotifications } from './macos-notification-center'
import { activeNotificationsById } from './native-notification-lifecycle'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/**
 * Retire the announced notifications of a whole worktree. Window-side reads go
 * through the renderer's dismiss IPC; an acknowledgement from the CLI or
 * orchestration has no focused window to drive that path, so desktop
 * notifications linger until they age out (#37328).
 */
export function dismissAnnouncedNotificationsForWorktree(
  worktreeId: string,
  runtime?: OrcaRuntimeService
): number {
  const announced = sessionAnnouncedNotifications()
  if (!announced) {
    return 0
  }
  const retiredByPane = announced.takeByWorktree(worktreeId)
  const ids = new Set<string>()
  // Announcements without a journal origin also live on the phone relay.
  const genericMobileIds = new Set<string>()
  for (const { paneKey, entries, hasOtherWorktreeEntries } of retiredByPane) {
    for (const entry of entries) {
      ids.add(entry.id)
      if (!entry.origin) {
        genericMobileIds.add(entry.id)
      }
    }
    // A shared pane group still holds another worktree's notifications; remove
    // only this worktree's positioned ids so the group keeps its other members.
    removeReadMacosNotifications(
      paneKey,
      entries,
      hasOtherWorktreeEntries ? { onlyIds: true } : undefined
    )
  }
  let dismissed = 0
  for (const id of ids) {
    const live = activeNotificationsById.get(id)
    if (live) {
      live.notification.close()
      live.release()
      dismissed += 1
    }
    if (genericMobileIds.has(id)) {
      runtime?.dismissMobileNotification(id)
    }
  }
  return dismissed
}
