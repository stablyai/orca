import { sameRuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { admitModernAdoptions } from './runtime-browser-client-page-modern-adoption'
import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserHostLease } from '../../browser-host/leases/browser-host-lease-records'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import {
  buildClientPageAdoptionIntents,
  selectAdoptableClientHostedPages,
  type AdoptableClientHostedPage
} from '../../browser-host/client-pages/browser-host-client-page-adoption'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

type AdoptionAuthority = Pick<
  BrowserHostLeaseRegistry,
  | 'authorityRuntimeId'
  | 'authorityEpoch'
  | 'adoptClientPages'
  | 'getPlacement'
  | 'admitClientPageInitialization'
  | 'retireUnpublishedClientPage'
>

/** Unavailable routes leave real workspaces/pages alive; only workspace-gone proves there is nowhere to restore. */
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
  /** Keep rows for failed/deferred adoption: client guests remain live until reconciliation can finish. */
  unadoptedPageIds: readonly string[]
  /** Claimed initializations remain unpublished but must not be admitted again by recovery. */
  claimedPageIds?: readonly string[]
}

const NOTHING_TO_ADOPT: RuntimeBrowserClientPageAdoptionResult = Object.freeze({
  adoptedPageIds: Object.freeze([]),
  unadoptedPageIds: Object.freeze([])
})

/** After restart, reclaim live client guests under new authority instead of recreating them; best-effort failure must not reject attach. */
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
  const inventoryByPageId = new Map(inventory.map((page) => [page.browserPageId, page]))
  const modern = options.lease.hostCapabilities.includes(
    BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY
  )
  const pending = (page: BrowserClientHostedPageInventory): boolean =>
    page.state !== 'active' || (!modern && page.currentUrl === undefined)
  const adoptable = selectAdoptableClientHostedPages({
    inventory,
    browserHostClientId: options.lease.browserHostClientId,
    authorityRuntimeId: options.authority.authorityRuntimeId,
    hasSavedPage: (inventory) => {
      const page = options.pages.getPage(inventory.browserPageId)
      return Boolean(
        page &&
        page.pairedDeviceId === options.lease.pairedDeviceId &&
        page.workspaceId === inventory.workspaceId &&
        page.browserProfileId === inventory.browserProfileId &&
        (isRestoredClientHostedBrowserPlacement(page.placement) ||
          (pending(inventory) &&
            page.placement.browserHostClientId === inventory.browserHostClientId &&
            page.placement.browserHostGeneration === inventory.browserHostGeneration &&
            page.placement.pageHostGeneration === inventory.pageHostGeneration))
      )
    },
    // Persisted rows have no guest; let adoption rekey the reported live DOM rather than recovery destroy and recreate it.
    hasRuntimePage: (browserPageId) => {
      const page = options.pages.getPage(browserPageId)
      const observed = inventoryByPageId.get(browserPageId)
      return (
        page !== undefined &&
        !isRestoredClientHostedBrowserPlacement(page.placement) &&
        !(
          observed &&
          pending(observed) &&
          page.pairedDeviceId === options.lease.pairedDeviceId &&
          page.workspaceId === observed.workspaceId &&
          page.browserProfileId === observed.browserProfileId &&
          page.placement.pageHostGeneration === observed.pageHostGeneration &&
          page.placement.browserHostClientId === observed.browserHostClientId &&
          page.placement.browserHostGeneration === observed.browserHostGeneration
        )
      )
    }
  })
  if (adoptable.length === 0) {
    return NOTHING_TO_ADOPT
  }
  if (options.lease.hostCapabilities.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY)) {
    return admitModernAdoptions(options, adoptable)
  }
  const captured = new Map(
    adoptable.map((page) => [page.browserPageId, options.pages.getPage(page.browserPageId)])
  )
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
  // Gone workspaces settle permanently; other unadopted pages remain pending.
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
    executionHostKeyByWorkspaceId,
    savedUrlByPageId: new Map(
      [...captured].flatMap(([id, page]) => (page ? [[id, page.url] as const] : []))
    )
  })
  if (intents.length === 0) {
    return { adoptedPageIds: [], unadoptedPageIds: settle(adoptable) }
  }
  const intentsByPageId = new Map(intents.map((intent) => [intent.browserPageId, intent]))
  const adoptedPlacements = new Map<string, RuntimeBrowserClientPlacement>()
  const adoptedPageIds = new Set(
    await options.authority.adoptClientPages(
      {
        authorityEpoch: options.lease.authorityEpoch,
        browserHostClientId: options.lease.browserHostClientId,
        browserHostGeneration: options.lease.browserHostGeneration,
        pairedDeviceId: options.lease.pairedDeviceId
      },
      intents,
      { signal: options.signal, onAdopted: (id, placement) => adoptedPlacements.set(id, placement) }
    )
  )
  const byPageId = new Map(adoptable.map((page) => [page.browserPageId, page]))
  const publishedWorkspaces = new Set<string>()
  const publishedPageIds: string[] = []
  for (const browserPageId of adoptedPageIds) {
    const page = byPageId.get(browserPageId)
    const intent = intentsByPageId.get(browserPageId)
    const placement = adoptedPlacements.get(browserPageId)
    if (!page || !intent || placement?.kind !== 'client') {
      continue
    }
    try {
      const restored = options.pages.getPage(browserPageId)
      const expected = captured.get(browserPageId)
      if (
        (expected &&
          (!restored || !sameRuntimeBrowserPlacement(restored.placement, expected.placement))) ||
        (!expected && restored !== undefined)
      ) {
        options.authority.retireUnpublishedClientPage(options.lease, {
          browserPageId,
          browserProfileId: page.browserProfileId,
          workspaceId: page.workspaceId,
          expected: placement,
          url: intent.url ?? adoptedPageUrl(page),
          isCurrent: () => false,
          resolveExecutionHostKey: async () => null,
          publish: () => {}
        })
        continue
      }
      if (restored && isRestoredClientHostedBrowserPlacement(restored.placement)) {
        // Retire before replacing from host inventory: publishing over a live id is refused.
        options.pages.retirePage(browserPageId, restored.placement)
      }
      options.pages.publishClientPage({
        browserPageId,
        workspaceId: page.workspaceId,
        browserProfileId: page.browserProfileId,
        executionHostKey: intent.executionHostKey,
        placement,
        pairedDeviceId: options.lease.pairedDeviceId,
        url: intent.url ?? adoptedPageUrl(page),
        loading: false,
        // Leave focus to client activation reports; adopting active would deactivate a visible sibling.
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
