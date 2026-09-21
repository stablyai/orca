import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserHostLease } from './browser-host-lease-records'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import {
  buildClientPageAdoptionIntents,
  selectAdoptableClientHostedPages,
  type AdoptableClientHostedPage
} from './browser-host-client-page-adoption'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

type AdoptionAuthority = Pick<
  BrowserHostLeaseRegistry,
  'authorityRuntimeId' | 'authorityEpoch' | 'adoptClientPages' | 'getPlacement'
>

/**
 * Where a workspace's client-hosted pages would be routed now.
 *
 * `unavailable` is deliberately not `workspace-gone`: the workspace is still real and its pages are
 * still live, the route just cannot be minted yet. Only `workspace-gone` is evidence a page has
 * nothing left to be restored into.
 */
export type BrowserExecutionHostKeyResolution =
  | { status: 'resolved'; executionHostKey: string }
  | { status: 'workspace-gone' }
  | { status: 'unavailable' }

export type RuntimeBrowserClientPageAdoptionOptions = {
  lease: BrowserHostLease
  authority: AdoptionAuthority
  pages: RuntimeBrowserPageRegistry
  notifyWorkspace: (workspaceId: string) => void
  /** The execution-host key that workspace's pages would be created under now. */
  resolveExecutionHostKey: (workspaceId: string) => Promise<BrowserExecutionHostKeyResolution>
  signal?: AbortSignal
}

export type RuntimeBrowserClientPageAdoptionResult = {
  /** Pages this runtime took back and republished, in inventory order. */
  adoptedPageIds: readonly string[]
  /**
   * Adoptable pages this attach did not take back -- a workspace whose route is not up yet, a
   * reconciliation that failed part way. Their guests are still live on the client, so the caller
   * must keep holding their rows rather than declaring this client reconciled.
   */
  unadoptedPageIds: readonly string[]
}

const NOTHING_TO_ADOPT: RuntimeBrowserClientPageAdoptionResult = Object.freeze({
  adoptedPageIds: Object.freeze([]),
  unadoptedPageIds: Object.freeze([])
})

/**
 * Rebuilds this runtime's client-hosted page records from the inventory an attaching host reports.
 *
 * A runtime restart loses the page registry but not the guests: the client still holds them, and
 * `reclaimPage` rekeys a live guest onto the new authority rather than recreating it. Adoption is
 * best effort -- a page it cannot take stays the client's problem to retire, and never fails attach.
 */
export async function adoptRuntimeBrowserClientPagesFromInventory(
  options: RuntimeBrowserClientPageAdoptionOptions
): Promise<RuntimeBrowserClientPageAdoptionResult> {
  const inventory = options.lease.pageInventory
  if (
    options.lease.pageReconciliationProtocolVersion !== 1 ||
    options.lease.pageInventoryProtocolVersion !== 1 ||
    options.lease.pageCommandProtocolVersion !== 1 ||
    !inventory
  ) {
    return NOTHING_TO_ADOPT
  }
  const adoptable = selectAdoptableClientHostedPages({
    inventory,
    browserHostClientId: options.lease.browserHostClientId,
    authorityRuntimeId: options.authority.authorityRuntimeId,
    // Why a rehydrated row does not count as a page we already track: it is a record without a
    // guest, and this client is reporting the guest. Adoption is the branch that rekeys a live
    // guest onto this authority, so letting the persisted row shadow it would push a page whose
    // DOM is still alive down the recovery path, which recreates it from scratch instead.
    hasRuntimePage: (browserPageId) => {
      const page = options.pages.getPage(browserPageId)
      return page !== undefined && !isRestoredClientHostedBrowserPlacement(page.placement)
    }
  })
  if (adoptable.length === 0) {
    return NOTHING_TO_ADOPT
  }
  const executionHostKeyByWorkspaceId = new Map<string, string>()
  const goneWorkspaceIds = new Set<string>()
  for (const workspaceId of new Set(adoptable.map((page) => page.workspaceId))) {
    const resolved = await options.resolveExecutionHostKey(workspaceId)
    if (resolved.status === 'resolved') {
      executionHostKeyByWorkspaceId.set(workspaceId, resolved.executionHostKey)
    } else if (resolved.status === 'workspace-gone') {
      goneWorkspaceIds.add(workspaceId)
    }
  }
  // A page whose workspace is gone is settled, not pending: nothing will ever restore it, so it must
  // not hold this client's rows open. Anything else unadopted is a "not yet".
  const settle = (pages: readonly AdoptableClientHostedPage[]): readonly string[] =>
    pages
      .filter((page) => !goneWorkspaceIds.has(page.workspaceId))
      .map((page) => page.browserPageId)
  const intents = buildClientPageAdoptionIntents({
    pages: adoptable,
    authority: {
      authorityRuntimeId: options.authority.authorityRuntimeId,
      authorityEpoch: options.authority.authorityEpoch
    },
    lease: {
      browserHostClientId: options.lease.browserHostClientId,
      browserHostGeneration: options.lease.browserHostGeneration
    },
    executionHostKeyByWorkspaceId
  })
  if (intents.length === 0) {
    return { adoptedPageIds: [], unadoptedPageIds: settle(adoptable) }
  }
  const intentsByPageId = new Map(intents.map((intent) => [intent.browserPageId, intent]))
  const adoptedPageIds = new Set(
    await options.authority.adoptClientPages(
      {
        authorityEpoch: options.lease.authorityEpoch,
        browserHostClientId: options.lease.browserHostClientId,
        browserHostGeneration: options.lease.browserHostGeneration,
        pairedDeviceId: options.lease.pairedDeviceId
      },
      intents,
      options.signal ? { signal: options.signal } : {}
    )
  )
  const byPageId = new Map(adoptable.map((page) => [page.browserPageId, page]))
  const publishedWorkspaces = new Set<string>()
  const publishedPageIds: string[] = []
  for (const browserPageId of adoptedPageIds) {
    const page = byPageId.get(browserPageId)
    const intent = intentsByPageId.get(browserPageId)
    const placement = options.authority.getPlacement(browserPageId)
    if (!page || !intent || placement?.kind !== 'client') {
      continue
    }
    try {
      const restored = options.pages.getPage(browserPageId)
      if (restored && isRestoredClientHostedBrowserPlacement(restored.placement)) {
        // Why retire rather than update in place: the record is being replaced wholesale by the
        // host's own report, and publishing over a live id is refused by design.
        options.pages.retirePage(browserPageId, restored.placement)
      }
      options.pages.publishClientPage({
        browserPageId,
        workspaceId: page.workspaceId,
        browserProfileId: page.browserProfileId,
        executionHostKey: intent.executionHostKey,
        placement,
        pairedDeviceId: options.lease.pairedDeviceId,
        url: adoptedPageUrl(page),
        loading: false,
        // Adoption never decides focus: activating here would deactivate whichever sibling the
        // client is actually showing, and the client republishes its own activation.
        active: false
      })
      publishedWorkspaces.add(page.workspaceId)
      publishedPageIds.push(browserPageId)
    } catch (error) {
      console.warn('[browser-host-lease] client page adoption publish failed:', {
        browserPageId,
        error
      })
    }
  }
  for (const workspaceId of publishedWorkspaces) {
    options.notifyWorkspace(workspaceId)
  }
  const published = new Set(publishedPageIds)
  return {
    adoptedPageIds: publishedPageIds,
    unadoptedPageIds: settle(adoptable.filter((page) => !published.has(page.browserPageId)))
  }
}

function adoptedPageUrl(page: BrowserClientHostedPageInventory): string {
  return page.currentUrl ?? 'about:blank'
}
