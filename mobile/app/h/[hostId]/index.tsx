import { useCallback, useEffect, useState } from 'react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { readCachedPageVersion } from '../../../src/mobile-web-shell/process-generation-store'
import { MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS } from '../../../src/transport/web-bundle/mobile-web-bundle-compat'
import {
  BRIDGE_OPEN_ROUTE_PARAM,
  type BridgeClearableRouteParam
} from '../../../src/mobile-web-shell/bridge/bridge-route-update'

// Encode decoded hostId so ?, # and whitespace cannot form a pathname the page refuses; shell gates unsupported bundles.
function HostListScreen() {
  // Use firstParam: encoding String(array) creates a valid segment naming a nonexistent host; an empty array is truthy and otherwise builds /h/.
  const params = useLocalSearchParams<{ hostId?: string | string[]; open?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  // A session to open inside this document (Jump back in, notification taps); empty once spent.
  const open = firstParam(params[BRIDGE_OPEN_ROUTE_PARAM])
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

  // Erase only the target the page took, so a later tap survives and a document reload cannot reopen it.
  const eraseOpen = useCallback(
    (param: BridgeClearableRouteParam, value: string) => {
      if (param === BRIDGE_OPEN_ROUTE_PARAM && open !== '' && value === open) {
        navigation.setParams({ [BRIDGE_OPEN_ROUTE_PARAM]: '' })
      }
    },
    [navigation, open]
  )

  // Validate through bridge schema: encoding cannot make dot/dot-dot host ids valid.
  const route =
    hostId === ''
      ? null
      : shellScreenRoute({
          pathname: `/h/${encodeURIComponent(hostId)}`,
          ...(open !== '' && open === openable
            ? { params: { [BRIDGE_OPEN_ROUTE_PARAM]: open } }
            : {})
        })
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return (
    <MobileWebShellScreen
      // Remount on host change to discard the old session’s grants; `open` updates the document in place.
      key={hostId}
      hostId={hostId}
      route={route}
      onRouteParamClear={eraseOpen}
    />
  )
}

// Wide: the session owns the whole host area when the page declares `canOwnHostArea`.
export default HostListScreen
