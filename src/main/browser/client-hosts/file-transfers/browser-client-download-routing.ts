import type {
  BrowserClientDownloadRoute,
  BrowserClientDownloadRouteOutcome
} from './browser-client-download-relay'

export type BrowserClientDownloadRouter = {
  route(input: { guestWebContentsId: number }): BrowserClientDownloadRouteOutcome
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

export function setBrowserClientRouteWebContentsProbe(
  probe: ((webContentsId: number) => boolean) | null
): void {
  isClientRouteWebContents = probe
}

export function resetBrowserClientDownloadRouting(): void {
  routersByEnvironmentId.clear()
  isClientRouteWebContents = null
}

export function routeBrowserClientDownload(input: {
  guestWebContentsId: number
}): BrowserClientDownloadDecision {
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
