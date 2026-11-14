import type { BrowserClientPageNetworkRoute } from '../../network/client-routes/browser-client-page-network-route'
import type { BrowserClientPageRenderer } from '../renderer/browser-client-page-renderer-contract'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import type { BrowserRouteGuestLifecycleClaim } from '../../routing/guest-authority/browser-route-page-authority'
import type { BrowserRouteSessionHandle } from '../../routing/sessions/browser-route-session-state'
import type { BrowserRouteWebContentsRegistry } from '../../routing/guest-authority/browser-route-webcontents-registry'
import { browserClientPageIdentity } from '../renderer/browser-client-page-renderer-contract'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

export function createBrowserClientPageCleanup(
  routeWebContents: Pick<BrowserRouteWebContentsRegistry, 'beginGuestRetirement'>,
  target: {
    guestMayExist: boolean
    lifecycleClaim: BrowserRouteGuestLifecycleClaim | null
    renderer: BrowserClientPageRenderer | null
    rendererPages: readonly Readonly<BrowserClientPageRendererIdentity>[]
    routeSession: BrowserRouteSessionHandle | null
    route: BrowserClientPageNetworkRoute | null
  }
): BrowserClientPageCleanup {
  const claim = target.lifecycleClaim
  const beginRetirement = cleanupStep(() => {
    if (target.guestMayExist && !claim) {
      throw new Error('Browser client page guest destruction was not observable')
    }
    if (claim && !routeWebContents.beginGuestRetirement(claim)) {
      throw new Error('Browser client page guest retirement was not admitted')
    }
  })
  const retireRenderer = target.rendererPages.map((identity) =>
    cleanupStep(() => target.renderer?.retirePage(identity))
  )
  const joinDestruction = cleanupStep(() => claim?.whenDestroyed, false)
  // Resource releases may consume their reference before rejecting; preserve that exact result.
  const releaseSession = cleanupStep(() => target.routeSession?.release(), false)
  const releaseRoute = cleanupStep(() => target.route?.release(), false)
  const cleanup = joinCleanupAttempt(async () => {
    const failures: unknown[] = []
    await collectCleanupFailure(beginRetirement, failures)
    for (const retire of retireRenderer) {
      await collectCleanupFailure(retire, failures)
    }
    const guestDestroyed =
      !target.guestMayExist || (claim && (await collectCleanupFailure(joinDestruction, failures)))
    if (guestDestroyed) {
      await collectCleanupFailure(releaseSession, failures)
      await collectCleanupFailure(releaseRoute, failures)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client page cleanup failed')
    }
  })
  return Object.assign(cleanup, {
    nativeNetworkRetired: () =>
      beginRetirement.succeeded() &&
      (!target.guestMayExist || joinDestruction.succeeded()) &&
      releaseSession.succeeded() &&
      releaseRoute.succeeded()
  })
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
  previousRendererPage?: Readonly<BrowserClientPageRendererIdentity>
): Promise<void> {
  if (!page.cleanup) {
    const { registration, generation, inventory, lifecycleClaim, renderer, route, routeSession } =
      page
    const retireAutomation = cleanupStep(() =>
      dependencies.retireAutomation({
        browserPageId: inventory.browserPageId,
        pageHostGeneration: generation,
        registration
      })
    )
    const currentRendererPage = browserClientPageIdentity(registration, registration.partition)
    const cleanupNative = createBrowserClientPageCleanup(dependencies.routeWebContents, {
      guestMayExist: true,
      lifecycleClaim,
      renderer: browserClientPageRendererIsCurrent(renderer) ? renderer : null,
      rendererPages: previousRendererPage
        ? [currentRendererPage, previousRendererPage]
        : [currentRendererPage],
      route,
      routeSession
    })
    const releaseUploads = cleanupStep(() => dependencies.releaseUploadStaging?.(), false)
    page.cleanup = Object.assign(
      joinCleanupAttempt(async () => {
        const failures: unknown[] = []
        await collectCleanupFailure(retireAutomation, failures)
        await collectCleanupFailure(cleanupNative, failures)
        await collectCleanupFailure(releaseUploads, failures)
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Browser client page cleanup failed')
        }
      }),
      { nativeNetworkRetired: cleanupNative.nativeNetworkRetired }
    )
  }
  page.retiring = page.cleanup()
  await page.retiring
}

function joinCleanupAttempt(run: () => Promise<void>): () => Promise<void> {
  let attempt: Promise<void> | undefined
  return () => {
    attempt ??= run().finally(() => {
      attempt = undefined
    })
    return attempt
  }
}

type CleanupStep = (() => Promise<void>) & { succeeded(): boolean }
export type BrowserClientPageCleanup = (() => Promise<void>) & { nativeNetworkRetired(): boolean }

function cleanupStep(run: () => void | Promise<void>, retryable = true): CleanupStep {
  let succeeded = false
  let result: Promise<void> | undefined
  const step = async (): Promise<void> => {
    result ??= Promise.resolve().then(run)
    try {
      await result
      succeeded = true
    } catch (error) {
      if (retryable) {
        result = undefined
      }
      throw error
    }
  }
  return Object.assign(step, { succeeded: () => succeeded })
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
