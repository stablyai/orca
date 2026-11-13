import { useCallback, useEffect } from 'react'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import {
  sessionOfPageLocation,
  setHostDocumentSession
} from '../notifications/delivery-policy/notification-viewing-policy'
import {
  BRIDGE_OPEN_ROUTE_PARAM,
  type BridgeClearableRouteParam
} from './bridge/bridge-route-update'

// A session the host list's document opens inside itself (Jump back in, notification taps), and the session its page shows.
export function useHostDocumentOpenTarget(hostId: string): {
  routeParams: Record<string, string> | undefined
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  onPageLocation: (href: string) => void
} {
  const requested = firstParam(useLocalSearchParams<{ open?: string | string[] }>().open)
  // Only this host's sessions: a deep link can set the param too.
  const open = requested.startsWith(`/h/${encodeURIComponent(hostId)}/session/`) ? requested : ''
  const navigation = useNavigation<{ setParams: (params: Record<string, string>) => void }>()

  useEffect(() => () => setHostDocumentSession(hostId, null), [hostId])

  return {
    // The shell hands it to the page it activates, or pushes it natively when that page is older than `open`.
    routeParams: open === '' ? undefined : { [BRIDGE_OPEN_ROUTE_PARAM]: open },
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
