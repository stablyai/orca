import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserHostLease } from './browser-host/browser-host-lease-records'
import type { BrowserHostLeaseRegistry } from './browser-host/browser-host-lease-registry'
import {
  buildClientPageAdoptionIntents,
  selectAdoptableClientHostedPages,
  type AdoptableClientHostedPage
} from './browser-host/browser-host-client-page-adoption'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

type AdoptionAuthority = Pick<
  BrowserHostLeaseRegistry,
  'authorityRuntimeId' | 'authorityEpoch' | 'adoptClientPages' | 'getPlacement'
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
  const adoptable = selectAdoptableClientHostedPages({
    inventory,
    browserHostClientId: options.lease.browserHostClientId,
    authorityRuntimeId: options.authority.authorityRuntimeId,
    // Persisted rows have no guest; let adoption rekey the reported live DOM rather than recovery destroy and recreate it.
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
        url: adoptedPageUrl(page),
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
