import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from '../mobile-web-shell/cancelled-navigation-target'
import { usePageBridgeClient } from '../transport/client-context.web'

// Older shells lack externalNavigation and cancel link taps silently; hide links while keeping the artifact and Source toggle usable (ruling 37.2).
// Read during render: init precedes mount and grants remain fixed for the document lifetime.
export function useHtmlPreviewLinkGrant(): boolean {
  const client = usePageBridgeClient()
  return client.getShellSession()?.grants.native.includes(BRIDGE_EXTERNAL_NAVIGATION_GRANT) === true
}
