import { MobileSessionRouteScreen } from '../../../../src/session/MobileSessionRouteScreen'

/**
 * Web sibling for the session screen.
 *
 * The shell renders this page for this route, so there is no shell to mount here and no flag to
 * read. The screen reads its own params, so this file is the whole of the difference: its native
 * sibling reaches OrcaMobileWebShellView, whose module calls requireNativeViewManager at import and
 * throws in a browser, and the route manifest imports every route.
 */
export default function MobileSessionScreen() {
  return <MobileSessionRouteScreen />
}
