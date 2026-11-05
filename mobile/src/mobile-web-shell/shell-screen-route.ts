// Import the defining module: the envelope re-export cycles through this file and becomes undefined in the page bundle.
import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge/bridge-init-route'

// Validate against the page’s schema here so overlong params (including Windows paths) and unencodable dot segments get a route refusal instead of init.route:null and a misleading update prompt.
export function shellScreenRoute(route: BridgeInitRoute): BridgeInitRoute | null {
  return BridgeInitRouteSchema.safeParse(route).success ? route : null
}

// Include params in remount identity so files/labels update the document; pane taps deliberately use a separate in-place init path.
// Match the page bootstrap serializer, pinned by tests instead of importing its RPC/document dependencies into native routes.
export function shellScreenRouteKey(route: BridgeInitRoute): string {
  const search = new URLSearchParams(route.params ?? {}).toString()
  return search === '' ? route.pathname : `${route.pathname}?${search}`
}
