import type { BrowserRouteViewer } from '../../routing/sessions/browser-route-session-policy'

// Each environment's live client-host composition, keyed so a replaced one's close can't clear its successor.
const viewers = new Map<string, { viewer: BrowserRouteViewer }>()

/** Records the viewer a composition decided at start; the returned release forgets only that one. */
export function recordClientHostViewer(
  environmentId: string,
  viewer: BrowserRouteViewer
): () => void {
  const entry = { viewer }
  viewers.set(environmentId, entry)
  return () => {
    if (viewers.get(environmentId) === entry) {
      viewers.delete(environmentId)
    }
  }
}

/** The viewer this environment's live client host decided at start; null without one. */
export function pairedRuntimeBrowserClientHostViewer(
  environmentId: string
): BrowserRouteViewer | null {
  return viewers.get(environmentId)?.viewer ?? null
}
