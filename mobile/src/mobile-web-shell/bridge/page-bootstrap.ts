import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic,
  type BridgeShellSession
} from './bridge-rpc-client'
import type { BridgeInitRoute } from './bridge-envelope'
import {
  createOrcaBridgePageTransport,
  readOrcaBridgePageChannel
} from './orca-bridge-page-channel'

// Stamp boot progress to distinguish no script, thrown startup and unanswered shell; unbridged and shell-too-old are terminal states.
export type PageMountState = 'started' | 'unbridged' | 'shell-too-old' | 'shell-ready' | 'mounted'

export const PAGE_MOUNT_STATE_KEY = 'orcaWebEntry'
export const PAGE_SESSION_ID_KEY = 'orcaWebSessionId'
export const PAGE_BUILD_ID_KEY = 'orcaWebBuildId'

export type PageMountTarget = { dataset: DOMStringMap }

export function stampPageMountState(target: PageMountTarget, state: PageMountState): void {
  target.dataset[PAGE_MOUNT_STATE_KEY] = state
}

export function createPageDiagnosticReporter(): (diagnostic: BridgeRpcClientDiagnostic) => void {
  const reported = new Set<BridgeRpcClientDiagnostic['kind']>()
  return (diagnostic) => {
    if (reported.has(diagnostic.kind)) {
      return
    }
    reported.add(diagnostic.kind)
    console.warn('[page-bridge]', diagnostic.kind, diagnostic)
  }
}

// Create one client before render: the channel’s single onmessage slot would let a second silently steal frames.
export function createShellPageClient(): BridgeRpcClient | null {
  const channel = readOrcaBridgePageChannel()
  if (channel === null) {
    return null
  }
  return createBridgeRpcClient({
    ...createOrcaBridgePageTransport(channel),
    onDiagnostic: createPageDiagnosticReporter()
  })
}

export function shellRouteHref(route: BridgeInitRoute): string {
  const search = new URLSearchParams(route.params ?? {}).toString()
  return search === '' ? route.pathname : `${route.pathname}?${search}`
}

export type ShellPageBootstrapOptions = {
  target: PageMountTarget
  client: BridgeRpcClient | null
  replaceUrl: (href: string) => void
  mount: (client: BridgeRpcClient, session: BridgeShellSession) => void
  refuseUnroutedShell: () => void
}

// Wait for init to prime synchronous getters, then rewrite history before Expo Router mounts; the served / path names no screen.
// Without a channel or route, show the terminal explanation rather than guess a screen or wait forever.
export function bootstrapShellPage(options: ShellPageBootstrapOptions): void {
  const { target, client, replaceUrl, mount, refuseUnroutedShell } = options
  if (client === null) {
    stampPageMountState(target, 'unbridged')
    return
  }
  const settleWithSession = (): boolean => {
    const session = client.getShellSession()
    if (session === null) {
      return false
    }
    target.dataset[PAGE_SESSION_ID_KEY] = session.sessionId
    target.dataset[PAGE_BUILD_ID_KEY] = session.buildId
    if (session.route === null) {
      // An older shell will never name a route in a later init; stop with the explanation instead of leaving a blank document waiting.
      stampPageMountState(target, 'shell-too-old')
      refuseUnroutedShell()
      return true
    }
    replaceUrl(shellRouteHref(session.route))
    stampPageMountState(target, 'shell-ready')
    mount(client, session)
    return true
  }
  if (settleWithSession()) {
    return
  }
  // Mount once per document; replacement sessions settle old work without adding a second router tree.
  client.onReady(() => {
    settleWithSession()
  })
}
