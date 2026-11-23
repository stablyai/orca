import type { BrowserDownloadFinishedEvent } from '../../../../shared/browser/guest-lifecycle/browser-guest-events'

export type BrowserClientDownloadRoute = {
  transferId: string
  browserPageId: string
  /** Temp file main hands to Chromium; never the user's Downloads folder. */
  stagingPath: string
  complete(
    filename: string
  ): Promise<NonNullable<BrowserDownloadFinishedEvent['remoteDestination']>>
  abort(): Promise<void>
}

export type BrowserClientDownloadRouteOutcome =
  /** Another composition may own this WebContents. */
  | { kind: 'unowned' }
  | { kind: 'remote'; route: BrowserClientDownloadRoute }
  /** A legacy host without the file channel permits a local save. */
  | { kind: 'local-fallback' }
  /** The owning page has no usable channel; refuse the download. */
  | { kind: 'unavailable' }

/** `filename` and `documentUrl` describe the download as it starts, for the page's host to claim it. */
export type BrowserClientDownloadRouteInput = {
  guestWebContentsId: number
  filename?: string
  documentUrl?: string
  /** An agent's `download` on this page is waiting for it. */
  agentDownload?: boolean
}

export type BrowserClientDownloadRouter = {
  route(input: BrowserClientDownloadRouteInput): BrowserClientDownloadRouteOutcome
}

export type BrowserClientDownloadDecision =
  | { kind: 'remote'; route: BrowserClientDownloadRoute }
  /** Ordinary guest or a legacy host without the file channel. */
  | { kind: 'local' }
  /** Refuse client-hosted downloads with unresolved ownership or an unusable channel. */
  | { kind: 'blocked' }

// Resolve the owning environment; another environment’s miss must not authorize a local save.
const routersByEnvironmentId = new Map<string, BrowserClientDownloadRouter>()

/** Includes client-hosted popups as well as route guests. */
let isClientRouteWebContents: ((webContentsId: number) => boolean) | null = null

export function registerBrowserClientDownloadRouter(
  environmentId: string,
  router: BrowserClientDownloadRouter
): () => void {
  routersByEnvironmentId.set(environmentId, router)
  return () => {
    if (routersByEnvironmentId.get(environmentId) === router) {
      routersByEnvironmentId.delete(environmentId)
    }
  }
}

// An agent's `download` claimed at a staging path whose file another host saves (an SSH host's command).
const claimedRoutesBySavePath = new Map<string, BrowserClientDownloadRoute>()

/** The download claimed at `route.stagingPath` goes through `route`. The returned unregistration
 *  says whether no download ever took it. */
export function registerClaimedBrowserDownloadRoute(
  route: BrowserClientDownloadRoute
): () => boolean {
  claimedRoutesBySavePath.set(route.stagingPath, route)
  return () => {
    if (claimedRoutesBySavePath.get(route.stagingPath) !== route) {
      return false
    }
    claimedRoutesBySavePath.delete(route.stagingPath)
    return true
  }
}

export function hasClaimedBrowserDownloadRoute(savePath: string): boolean {
  return claimedRoutesBySavePath.has(savePath)
}

export function takeClaimedBrowserDownloadRoute(
  savePath: string | null | undefined
): BrowserClientDownloadRoute | null {
  const route = (savePath && claimedRoutesBySavePath.get(savePath)) || null
  if (route) {
    claimedRoutesBySavePath.delete(route.stagingPath)
  }
  return route
}

export function setBrowserClientRouteWebContentsProbe(
  probe: ((webContentsId: number) => boolean) | null
): void {
  isClientRouteWebContents = probe
}

export function resetBrowserClientDownloadRouting(): void {
  routersByEnvironmentId.clear()
  isClientRouteWebContents = null
}

export function routeBrowserClientDownload(
  input: BrowserClientDownloadRouteInput
): BrowserClientDownloadDecision {
  for (const router of routersByEnvironmentId.values()) {
    let outcome: BrowserClientDownloadRouteOutcome
    try {
      outcome = router.route(input)
    } catch {
      // A failed lookup does not establish ownership; defer to the page probe.
      continue
    }
    if (outcome.kind === 'remote') {
      return { kind: 'remote', route: outcome.route }
    }
    if (outcome.kind === 'local-fallback') {
      return { kind: 'local' }
    }
    if (outcome.kind === 'unavailable') {
      return { kind: 'blocked' }
    }
  }
  if (!isClientHostedWebContents(input.guestWebContentsId)) {
    return { kind: 'local' }
  }
  // An unresolved client-hosted owner cannot authorize a local save.
  return { kind: 'blocked' }
}

function isClientHostedWebContents(webContentsId: number): boolean {
  try {
    return isClientRouteWebContents?.(webContentsId) === true
  } catch {
    return false
  }
}
