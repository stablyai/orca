import { useCallback, useState } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { LARGE_TITLE_COLLAPSE_OFFSET } from '../components/ui/NavBar'
import { useForceReconnect } from '../transport/host-client-hooks'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { useMobileTasksHostTitle } from './mobile-tasks-host-subtitle'

/** Which sheet's "…" menu is open: the issue/PR detail or the GitHub Project item detail. */
export type MobileTasksDetailMenu = 'item' | 'project' | null

type PageScroll = { key: string; scrolled: boolean; collapsed: boolean }

/**
 * Screen-local chrome state: the large title's collapse, the Filter & display sheet and the detail
 * sheets' overflow menus. Kept out of the data stages because none of it reaches the host.
 */
export function useMobileTasksPageChrome(model: ConnectionPresentationModel) {
  const { githubMode, gitlabView, hostId, linearViewMode, provider } = model
  const hostTitle = useMobileTasksHostTitle(hostId)
  const forceReconnect = useForceReconnect()
  const [showFilterSheet, setShowFilterSheet] = useState(false)
  const [detailMenu, setDetailMenu] = useState<MobileTasksDetailMenu>(null)
  // Keyed by the list on screen, so a freshly mounted list starts with its title expanded.
  const pageScrollKey = `${provider}:${githubMode}:${gitlabView}:${linearViewMode}`
  const [scroll, setScroll] = useState<PageScroll>({
    key: pageScrollKey,
    scrolled: false,
    collapsed: false
  })
  const current = scroll.key === pageScrollKey ? scroll : null
  const onPageScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y
      const scrolled = y > 1
      const collapsed = y > LARGE_TITLE_COLLAPSE_OFFSET
      setScroll((previous) =>
        previous.key === pageScrollKey &&
        previous.scrolled === scrolled &&
        previous.collapsed === collapsed
          ? previous
          : { key: pageScrollKey, scrolled, collapsed }
      )
    },
    [pageScrollKey]
  )
  return Object.assign(model, {
    hostTitle,
    reconnectHost: forceReconnect
      ? () => {
          // The connection state already reports a failed retry, so a rejection adds nothing.
          forceReconnect(hostId).catch(() => {})
        }
      : null,
    pageScrolled: current?.scrolled ?? false,
    pageTitleCollapsed: current?.collapsed ?? false,
    onPageScroll,
    showFilterSheet,
    setShowFilterSheet,
    detailMenu,
    setDetailMenu
  })
}

export type PageChromeModel = ReturnType<typeof useMobileTasksPageChrome>
