import { useEffect, useMemo } from 'react'
import { createUnreadBadgeCountSelector } from '@/attention/unread/unread-badge-count-selector'
import { useAppStore } from '@/store/index'
import { selectFloatingWorkspaceHasUnread } from '@/store/workspaces/floating/floating-workspace-unread-selector'

function setUnreadDockBadgeCountBestEffort(count: number): void {
  const setBadge = window.api?.app?.setUnreadDockBadgeCount
  if (!setBadge) {
    return
  }
  void setBadge(count).catch(() => {
    // Dock sync is best-effort chrome; stale badge state should not affect app use.
  })
}

/** Renders nothing; its own subscription keeps count changes from rerendering the App root. */
export function UnreadDockBadgeSync({
  floatingTerminalOpen
}: {
  floatingTerminalOpen: boolean
}): null {
  const enabled = useAppStore((s) => s.settings?.notifications?.dockUnreadBadge !== false)
  // Why recreated: the selector caches the last store state, which must not outlive turning the badge off.
  const selectUnreadBadgeCount = useMemo(
    () => (enabled ? createUnreadBadgeCountSelector() : null),
    [enabled]
  )
  const unreadWorkspaceCount = useAppStore((s) => selectUnreadBadgeCount?.(s) ?? 0)
  // Why: the floating terminal has no workspace flag, so it counts exactly while its launcher shows the dot.
  const floatingTerminalHasUnread = useAppStore(
    (s) =>
      enabled && s.settings?.floatingTerminalEnabled === true && selectFloatingWorkspaceHasUnread(s)
  )
  // Why capped: the Dock shows 99+ above 99, so larger counts would send without a visible change.
  const unreadCount = Math.min(
    100,
    unreadWorkspaceCount + (floatingTerminalHasUnread && !floatingTerminalOpen ? 1 : 0)
  )

  useEffect(() => {
    setUnreadDockBadgeCountBestEffort(unreadCount)
  }, [unreadCount])
  useEffect(() => () => setUnreadDockBadgeCountBestEffort(0), [])

  return null
}
