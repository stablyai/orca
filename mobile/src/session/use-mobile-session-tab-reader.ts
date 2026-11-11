import { useCallback, useLayoutEffect, useMemo, type MutableRefObject } from 'react'
import type { MobileSessionTab } from './tabs/mobile-session-tabs'

export function useMobileSessionTabReader(
  hostId: string,
  worktreeId: string,
  tabs: MutableRefObject<MobileSessionTab[]>
): {
  readSessionTab: (tabId: string) => MobileSessionTab | null
} {
  const route = useMemo(() => ({ live: false, hostId, worktreeId }), [hostId, worktreeId])
  useLayoutEffect(() => {
    route.live = true
    return () => {
      route.live = false
    }
  }, [route])
  const readSessionTab = useCallback(
    (tabId: string) => (route.live ? (tabs.current.find((tab) => tab.id === tabId) ?? null) : null),
    [route, tabs]
  )
  return { readSessionTab }
}
