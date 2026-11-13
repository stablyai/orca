import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../shared/browser-url'
import { batchBrowserPageInitializationNotifications } from './browser-page-initialization-notifications'
import {
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
  RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY
} from './client-hosted-browser-page-persistence'
import { admitRuntimeBrowserPageInitialization } from './runtime-browser-page-initialization'
import type {
  RuntimeBrowserClientPageAdoptionOptions,
  RuntimeBrowserClientPageAdoptionResult
} from './runtime-browser-client-page-adoption'
import type { AdoptableClientHostedPage } from '../../browser-host/client-pages/browser-host-client-page-adoption'

export function admitModernAdoptions(
  options: RuntimeBrowserClientPageAdoptionOptions,
  candidates: readonly AdoptableClientHostedPage[]
): RuntimeBrowserClientPageAdoptionResult {
  const remaining = new Set(candidates.map((page) => page.browserPageId))
  const published: string[] = []
  const claimed: string[] = []
  const ordered = [...candidates].sort((a, b) => a.pageHostGeneration - b.pageHostGeneration)
  const highest = ordered.reduce((value, page) => Math.max(value, page.pageHostGeneration), 0)
  batchBrowserPageInitializationNotifications(options.notifyWorkspace, (notifyWorkspace) => {
    for (const [index, inventory] of ordered.entries()) {
      if (options.signal?.aborted) {
        continue
      }
      const existing = options.pages.getPage(inventory.browserPageId)
      const page = existing ?? {
        browserPageId: inventory.browserPageId,
        workspaceId: inventory.workspaceId,
        browserProfileId: inventory.browserProfileId,
        pairedDeviceId: options.lease.pairedDeviceId,
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        executionHostKey: RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY,
        url: redactKagiSessionToken(
          normalizeBrowserNavigationUrl(inventory.currentUrl ?? 'about:blank') ?? 'about:blank'
        ),
        loading: false,
        active: false,
        title: 'Browser',
        canGoBack: false,
        canGoForward: false,
        metadataRevision: 0
      }
      try {
        const disposition = admitRuntimeBrowserPageInitialization({
          ...options,
          notifyWorkspace,
          page,
          previous: inventory,
          pageHostGeneration: highest + index + 1,
          url: inventory.currentUrl ?? page.url,
          creationTimeoutMs: 15_000,
          ...(!existing
            ? {
                claim: () => {
                  options.pages.publishClientPage(page)
                  notifyWorkspace(page.workspaceId)
                }
              }
            : {}),
          releaseUnrecoverablePage: (held) => {
            if (options.pages.retirePage(held.browserPageId, held.placement)) {
              notifyWorkspace(held.workspaceId)
            }
          },
          settled: (outcome) => {
            if (options.signal?.aborted) {
              return
            }
            if (outcome === 'published') {
              published.push(inventory.browserPageId)
            }
            if (outcome === 'published' || outcome === 'retained-clean' || outcome === 'disposed') {
              remaining.delete(inventory.browserPageId)
            }
          }
        })
        if (disposition !== 'stale') {
          claimed.push(inventory.browserPageId)
        }
      } catch (error) {
        console.warn('[browser-host-lease] client page initialization admission failed:', {
          browserPageId: inventory.browserPageId,
          error
        })
      }
    }
  })
  return { adoptedPageIds: published, unadoptedPageIds: [...remaining], claimedPageIds: claimed }
}
