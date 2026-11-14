import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../shared/browser-url'
import type { BrowserPageInitializationAction } from '../../../../shared/browser/client-hosting/browser-page-initialization-action'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { sameRuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'
import { admitRuntimeBrowserPageInitialization } from './runtime-browser-page-initialization'

export function captureRuntimeBrowserInitializationAction(
  pages: RuntimeBrowserPageRegistry,
  authority: BrowserHostLeaseRegistry,
  id: string,
  expected: RuntimeBrowserClientPlacement
): () => RuntimeBrowserClientPage {
  const captured = pages.getPage(id)
  if (!captured || !sameRuntimeBrowserPlacement(captured.placement, expected)) {
    throw new Error('browser_page_placement_stale')
  }
  const matches =
    authority.clientPageInitializations.capture(id, expected) ??
    ((placement: RuntimeBrowserClientPlacement) => sameRuntimeBrowserPlacement(placement, expected))
  return () => {
    const current = pages.getPage(id)
    if (
      !current ||
      current.workspaceId !== captured.workspaceId ||
      current.browserProfileId !== captured.browserProfileId ||
      !matches(current.placement)
    ) {
      throw new Error('browser_page_placement_stale')
    }
    return current
  }
}

/** Acceptance changes the current page owner synchronously; completion belongs to that admission. */
export function actOnRuntimeBrowserInitialization(input: {
  pages: RuntimeBrowserPageRegistry
  authority: BrowserHostLeaseRegistry
  page: RuntimeBrowserClientPage
  action: BrowserPageInitializationAction
  explicitUrl?: boolean
  resolveExecutionHostKey(workspaceId: string): Promise<BrowserExecutionHostKeyResolution>
  notifyWorkspace(workspaceId: string): void
}): Promise<string | undefined> {
  const { pages, authority, page, action } = input
  const url = action.type === 'navigate' ? normalizeBrowserNavigationUrl(action.url) : undefined
  if (action.type === 'navigate' && (!url || url.startsWith('file:'))) {
    throw new Error('browser_navigation_url_invalid')
  }
  const lease = authority.clientPageInitializations.lease(page.browserPageId, page.placement)
  if (input.explicitUrl && url) {
    pages.updatePage(page.browserPageId, page.placement, {
      url: redactKagiSessionToken(url),
      loading: true
    })
  }
  if (lease) {
    if (action.type === 'stop') {
      authority.clientPageInitializations.stop(page.browserPageId, page.placement)
      return Promise.resolve(undefined)
    }
    const completion = Promise.withResolvers<string>()
    // UI callers await acceptance only; keep later cancellation from becoming an unhandled rejection.
    void completion.promise.catch(() => {})
    const disposition = admitRuntimeBrowserPageInitialization({
      ...input,
      lease,
      url: url!,
      replace: true,
      completed: (destination) =>
        destination === undefined
          ? completion.reject(new Error('browser_client_page_initialization_cancelled'))
          : completion.resolve(destination)
    })
    if (disposition === 'stale' || disposition === 'closed') {
      completion.reject(new Error('browser_page_placement_stale'))
    }
    return completion.promise
  }
  const issued = authority.issueClientPageCommand(
    {
      authorityRuntimeId: authority.authorityRuntimeId,
      authorityEpoch: authority.authorityEpoch,
      browserPageId: page.browserPageId,
      ...page.placement
    },
    action.type === 'navigate'
      ? { type: 'navigate', url: url! }
      : {
          type: 'automation',
          method: 'browser.eval',
          params: { page: page.browserPageId, expression: 'window.stop()' },
          agent: false
        }
  )
  input.notifyWorkspace(page.workspaceId)
  return issued.result.then((result) => {
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    return typeof result.value === 'string' ? result.value : undefined
  })
}
