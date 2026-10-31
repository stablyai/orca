import { readBridgeExternalLinkUrl } from './bridge/bridge-caps'

// Offer cancelled top-frame HTML-preview links through the shared scheme/normalization rule; native only caps the URL and identifies its frame.
// Open normalized hrefs, never raw spellings with stripped controls; changed native payload shapes fail closed without throwing from frame callbacks.
export function cancelledShellNavigationTarget(url: unknown): string | null {
  return typeof url === 'string' ? readBridgeExternalLinkUrl(url) : null
}

// Negotiate externalNavigation so previews hide links on older shells that cancel them silently. This is a capability token, not a verb/notify; the browser initiates navigation.
// Both native engines dispatch it, so support belongs to the app build rather than platform detection (ruling 37.1).
export const BRIDGE_EXTERNAL_NAVIGATION_GRANT = 'externalNavigation'
