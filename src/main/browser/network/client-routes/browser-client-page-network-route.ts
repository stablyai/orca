import type { BrowserRouteProxyEndpoint } from '../../routing/sessions/browser-route-session-policy'

export type BrowserClientPageNetworkRoute = {
  key: string
  executionHostIdentity: string
  /** Pre-migration identity of the same host, so its existing partition can be adopted. */
  legacyExecutionHostIdentity: string
  proxyEndpoint: BrowserRouteProxyEndpoint
  release(): void | Promise<void>
}
