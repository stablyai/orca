import { useCallback, useEffect, useState } from 'react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import {
  sessionOfPageLocation,
  setHostDocumentSession
} from '../notifications/notification-viewing-policy'
import { MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS } from '../transport/web-bundle/mobile-web-bundle-compat'
import {
  BRIDGE_OPEN_ROUTE_PARAM,
  type BridgeClearableRouteParam
} from './bridge/bridge-route-update'
import { readCachedPageVersion } from './process-generation-store'

// A session the host list's document opens inside itself (Jump back in, notification taps), and the session its page shows.
export function useHostDocumentOpenTarget(hostId: string): {
  routeParams: Record<string, string> | undefined
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  onPageLocation: (href: string) => void
} {
  const requested = firstParam(useLocalSearchParams<{ open?: string | string[] }>().open)
  // Only this host's sessions: a deep link can set the param too.
  const open = requested.startsWith(`/h/${encodeURIComponent(hostId)}/session/`) ? requested : ''
  const router = useRouter()
  const navigation = useNavigation<{ setParams: (params: Record<string, string>) => void }>()
  const [openable, setOpenable] = useState('')

  // The shell reads the same cached build to open this screen, so this settles before the page asks for its first init.
  useEffect(() => {
    if (open === '') {
      return
    }
    let live = true
    void readCachedPageVersion(hostId).then((version) => {
      if (!live) {
        return
      }
      if ((version ?? 0) >= MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS) {
        setOpenable(open)
        return
      }
      // A page older than `open`, or none cached yet: push the session over this list as before.
      navigation.setParams({ [BRIDGE_OPEN_ROUTE_PARAM]: '' })
      router.push(open)
    })
    return () => {
      live = false
    }
  }, [hostId, navigation, open, router])

  useEffect(() => () => setHostDocumentSession(hostId, null), [hostId])

  return {
    routeParams: open !== '' && open === openable ? { [BRIDGE_OPEN_ROUTE_PARAM]: open } : undefined,
    // Erase only the target the page took, so a later tap survives and a document reload cannot reopen it.
    onRouteParamClear: useCallback(
      (param, value) => {
        if (param === BRIDGE_OPEN_ROUTE_PARAM && open !== '' && value === open) {
          navigation.setParams({ [BRIDGE_OPEN_ROUTE_PARAM]: '' })
        }
      },
      [navigation, open]
    ),
    onPageLocation: useCallback(
      (href: string) => setHostDocumentSession(hostId, sessionOfPageLocation(href)),
      [hostId]
    )
  }
}
