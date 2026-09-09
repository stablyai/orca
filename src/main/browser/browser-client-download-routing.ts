import type {
  BrowserClientDownloadRoute,
  BrowserClientDownloadRouteOutcome
} from './browser-client-download-relay'

export type BrowserClientDownloadRouter = {
  route(input: { guestWebContentsId: number }): BrowserClientDownloadRouteOutcome
}

export type BrowserClientDownloadDecision =
  /** Stage locally and stream to the owning page's remote workspace. */
  | { kind: 'remote'; route: BrowserClientDownloadRoute }
  /** Ordinary browser guest, or an owning host too old to have a file channel. */
  | { kind: 'local' }
  /** Client-hosted, but nothing can prove where the bytes belong: cancel instead of guessing. */
  | { kind: 'blocked' }

/**
 * One router per client-host composition, resolved by which composition actually owns the
 * WebContents. A single process-wide router would be whichever composition composed last, so a page
 * from one environment could be looked up in another environment's executor — and a miss there is
 * indistinguishable from "not client-hosted", which is how remote bytes reach the client's disk.
 */
const routersByEnvironmentId = new Map<string, BrowserClientDownloadRouter>()

/** True when the WebContents renders a client-hosted page (route guest or one of its popups). */
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

export function setBrowserClientRouteWebContentsProbe(
  probe: ((webContentsId: number) => boolean) | null
): void {
  isClientRouteWebContents = probe
}

export function resetBrowserClientDownloadRouting(): void {
  routersByEnvironmentId.clear()
  isClientRouteWebContents = null
}

/**
 * Fail-closed for client-hosted pages: only a resolved owner routes remotely, and only a host that
 * never offered the file channel keeps the desktop Downloads fallback. Ordinary browser guests are
 * unaffected — their downloads stay local as they always have.
 */
export function routeBrowserClientDownload(input: {
  guestWebContentsId: number
}): BrowserClientDownloadDecision {
  for (const router of routersByEnvironmentId.values()) {
    let outcome: BrowserClientDownloadRouteOutcome
    try {
      outcome = router.route(input)
    } catch {
      // A router that cannot answer proves nothing about ownership; the probe below decides.
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
  // A client-hosted page whose owner cannot be resolved (retiring, closed composition, failed
  // lookup) has no proven destination, and this desktop's Downloads folder is not it.
  return { kind: 'blocked' }
}

function isClientHostedWebContents(webContentsId: number): boolean {
  try {
    return isClientRouteWebContents?.(webContentsId) === true
  } catch {
    return false
  }
}
