import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from '../mobile-web-shell/cancelled-navigation-target'
import { usePageBridgeClient } from '../transport/client-context.web'

/**
 * Web sibling: the page asks the shell it is running inside, through the grants `init` gave it.
 *
 * Grants rather than a new `init` field, and the same read
 * `use-browser-binary-screencast-grant.web.ts` makes: one question, "is this name in
 * `grants.native`", against one list. A shell built before the cancelled-navigation event answers
 * no, and the preview renders the artifact with its links as text rather than offering a tap that
 * the shell cancels in silence.
 *
 * `externalNavigation` sits on the route's optional lane, so a no here is a hidden affordance and
 * never a native screen: the artifact still paints and the Source toggle still works, which is what
 * ruling 37.2 calls a complete screen.
 *
 * Read during render rather than per tap: the page entry waits for `init` before it mounts
 * anything, so the session is already there and its grants do not change for the life of the
 * document.
 */
export function useHtmlPreviewLinkGrant(): boolean {
  const client = usePageBridgeClient()
  return client.getShellSession()?.grants.native.includes(BRIDGE_EXTERNAL_NAVIGATION_GRANT) === true
}
