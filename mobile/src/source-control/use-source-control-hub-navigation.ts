import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionPager } from '../components/BottomDrawer'
import { useBackClaim } from '../navigation/use-back-claim'
import type { SourceControlHubRouteTab, SourceControlHubTab } from './mobile-source-control-hub-tab'
import type { PrTabScreen } from '../components/pr-sidebar/use-mobile-pr-tab'

// Screens pushed over the hub: Commits, and the PR tab's Checks and Comments.
export type SourceControlHubScreen = 'commits' | PrTabScreen

function hubTabFor(tab: SourceControlHubRouteTab): SourceControlHubTab {
  return tab === 'history' ? 'changes' : tab
}

/** The hub's segment and the screen pushed over it; `history` links open Commits over Changes. */
export function useSourceControlHubNavigation(initialTab: SourceControlHubRouteTab) {
  const screens = useOptionPager<SourceControlHubScreen>()
  const [activeTab, setActiveTab] = useState<SourceControlHubTab>(hubTabFor(initialTab))
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SourceControlHubTab>>(
    () => new Set<SourceControlHubTab>([hubTabFor(initialTab)])
  )

  const selectTab = useCallback((tab: SourceControlHubTab) => {
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [])

  // Query-only navigation reuses this screen; adopt the new tab. Only a tab change reruns this.
  const screensRef = useRef(screens)
  useEffect(() => {
    screensRef.current = screens
  })
  useEffect(() => {
    selectTab(hubTabFor(initialTab))
    // An explicit tab from outside (e.g. the session dock) must not stay hidden under a pushed page.
    if (initialTab === 'history') {
      screensRef.current.open('commits')
    } else if (screensRef.current.page !== null) {
      // Slide it away: dropping the page alone would leave the hub shifted under it.
      screensRef.current.close()
    }
  }, [initialTab, selectTab])

  useBackClaim(
    screens.page === null
      ? null
      : () => {
          screens.close()
          return true
        }
  )

  return { screens, activeTab, visitedTabs, selectTab }
}
