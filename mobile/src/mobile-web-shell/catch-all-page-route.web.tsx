import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'

/**
 * Web sibling for the catch-all. The page is what the native file's shell displays, so a shell
 * nested here would open a second document inside the first; and the module it reaches calls
 * `requireNativeViewManager` at import, which throws in a browser.
 *
 * A refusal rather than a redirect: the page reaches this route only for a pathname its own bundle
 * has no file for, which is a desktop that listed a screen it did not build. It is also what
 * replaces expo-router's Unmatched for every `/h/<id>/…` path on the page.
 */
export default function MobileWebPageCatchAllScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  return <PageRouteUnavailableScreen hostId={firstParam(params.hostId)} />
}
