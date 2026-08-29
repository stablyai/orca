import type { BrowserRouteGuestLifecycleClaim } from './browser-route-page-authority'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'
import type { BrowserRouteProxyEndpoint } from './browser-route-session-policy'
import type { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
import { browserClientPageIdentity } from './browser-client-page-command-admission'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

export type BrowserClientPageNetworkRoute = {
  key: string
  executionHostIdentity: string
  /** Pre-migration identity of the same host, so its existing partition can be adopted. */
  legacyExecutionHostIdentity: string
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

export async function cleanupRetainedBrowserClientPage(
  page: BrowserClientRetainedPage,
  dependencies: {
    routeWebContents: Pick<BrowserRouteWebContentsRegistry, 'beginGuestRetirement'>
    retireAutomation(input: {
      browserPageId: string
      pageHostGeneration: number
      registration: BrowserClientRetainedPage['registration']
    }): Promise<void>
    releaseUploadStaging?(): void | Promise<void>
  },
  previousRendererPage?: BrowserClientPageRendererIdentity
): Promise<void> {
  const failures: unknown[] = []
  try {
    await dependencies.retireAutomation({
      browserPageId: page.inventory.browserPageId,
      pageHostGeneration: page.generation,
      registration: page.registration
    })
  } catch (error) {
    failures.push(error)
  }
  const currentRendererPage = browserClientPageIdentity(
    page.registration,
    page.registration.partition
  )
  try {
    await cleanupBrowserClientPage(dependencies.routeWebContents, {
      guestMayExist: true,
      lifecycleClaim: page.lifecycleClaim,
      renderer: browserClientPageRendererIsCurrent(page.renderer) ? page.renderer : null,
      rendererPages: previousRendererPage
        ? [currentRendererPage, previousRendererPage]
        : [currentRendererPage],
      route: page.route,
      routeSession: page.routeSession
    })
  } catch (error) {
    failures.push(error)
  }
  // Why: staged upload copies of remote files must not outlive the page, but a temp file the guest
  // still holds open must not strand the guest, its route, or its partition either. Runs last so
  // the removal sees a destroyed guest.
  await collectCleanupFailure(() => dependencies.releaseUploadStaging?.(), failures)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client page cleanup failed')
  }
}

function browserClientPageRendererIsCurrent(renderer: BrowserClientPageRenderer): boolean {
  try {
    return renderer.isCurrent()
  } catch {
    return false
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
