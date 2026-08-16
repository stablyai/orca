import type { BrowserRouteGuestLifecycleClaim } from './browser-route-page-authority'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'
import type { BrowserRouteProxyEndpoint } from './browser-route-session-policy'
import type { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

export type BrowserClientPageNetworkRoute = {
  key: string
  executionHostIdentity: string
  proxyEndpoint: BrowserRouteProxyEndpoint
  release(): void | Promise<void>
}

export type BrowserClientPageRendererIdentity = Readonly<{
  partition: string
  browserPageId: string
  pageHostGeneration: number
}>

export type BrowserClientPageRenderer = {
  rendererWebContentsId: number
  isCurrent(): boolean
  mountPage(
    page: BrowserClientPageRendererIdentity,
    signal: AbortSignal
  ): Promise<{ webContentsId: number }>
  rekeyPage?(
    previous: BrowserClientPageRendererIdentity,
    next: BrowserClientPageRendererIdentity,
    signal: AbortSignal
  ): Promise<void>
  retirePage(page: BrowserClientPageRendererIdentity): void | Promise<void>
}

export async function cleanupBrowserClientPage(
  routeWebContents: Pick<BrowserRouteWebContentsRegistry, 'beginGuestRetirement'>,
  target: {
    guestMayExist: boolean
    lifecycleClaim: BrowserRouteGuestLifecycleClaim | null
    renderer: BrowserClientPageRenderer | null
    rendererPages: readonly BrowserClientPageRendererIdentity[]
    routeSession: BrowserRouteSessionHandle | null
    route: BrowserClientPageNetworkRoute | null
  }
): Promise<void> {
  const failures: unknown[] = []
  const guestDestruction = target.lifecycleClaim?.whenDestroyed ?? null
  let guestDestroyed = !target.guestMayExist
  if (target.guestMayExist && !target.lifecycleClaim) {
    failures.push(new Error('Browser client page guest destruction was not observable'))
  }
  if (target.lifecycleClaim) {
    try {
      if (!routeWebContents.beginGuestRetirement(target.lifecycleClaim)) {
        failures.push(new Error('Browser client page guest retirement was not admitted'))
      }
    } catch (error) {
      failures.push(error)
    }
  }
  const renderer = target.renderer
  if (renderer) {
    for (const rendererPage of target.rendererPages) {
      await collectCleanupFailure(() => renderer.retirePage(rendererPage), failures)
    }
  }
  if (guestDestruction) {
    guestDestroyed = await collectCleanupFailure(() => guestDestruction, failures)
  }
  const routeSession = target.routeSession
  if (routeSession && guestDestroyed) {
    await collectCleanupFailure(() => routeSession.release(), failures)
  }
  const route = target.route
  if (route && guestDestroyed) {
    await collectCleanupFailure(() => route.release(), failures)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client page cleanup failed')
  }
}

async function collectCleanupFailure(
  cleanup: () => void | Promise<void>,
  failures: unknown[]
): Promise<boolean> {
  try {
    await cleanup()
    return true
  } catch (error) {
    failures.push(error)
    return false
  }
}
