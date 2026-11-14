import { batchBrowserPageInitializationNotifications } from './browser-page-initialization-notifications'
import {
  isRecoverableByLease,
  isActiveExactPage,
  assertInventoryAuthority
} from './runtime-browser-client-page-recovery-authority'
import { recoverClientPagesWithConcurrency } from './runtime-browser-client-page-recovery-queue'
import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { admitRuntimeBrowserPageInitialization } from './runtime-browser-page-initialization'
import {
  BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

import { sameRuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'

const MAX_RECOVERY_CONCURRENCY = 4

type RecoveryAuthority = Pick<
  BrowserHostLeaseRegistry,
  | 'authorityRuntimeId'
  | 'authorityEpoch'
  | 'beginPageRetirement'
  | 'completePageRetirement'
  | 'createClientPage'
  | 'getPlacement'
  | 'claimLegacyClientPageRecovery'
  | 'admitClientPageInitialization'
> & {
  clientPageInitializations: Pick<
    BrowserHostLeaseRegistry['clientPageInitializations'],
    'canContinue'
  >
  issueClientPageCommand(
    authority: {
      authorityRuntimeId: string
      authorityEpoch: string
      browserPageId: string
      browserHostClientId: string
      browserHostGeneration: number
      pageHostGeneration: number
    },
    command: BrowserClientHostCommandEvent['command']
  ): { result: Promise<BrowserClientHostCommandResult> }
}

export async function recoverUnavailableRuntimeBrowserClientPages(options: {
  lease: BrowserClientHostLeaseAuthority & {
    pairedDeviceId: string
    connectionId?: string
    hostCapabilities?: readonly string[]
    pageInventory?: readonly BrowserClientHostedPageInventory[]
  }
  authority: RecoveryAuthority
  pages: RuntimeBrowserPageRegistry
  /** Placements as of the attach inventory. Omitting it recovers against unfenced live state. */
  pagePlacementsAtAttach?: ReadonlyMap<string, RuntimeBrowserClientPage['placement']>
  notifyWorkspace(workspaceId: string): void
  /** Drops a page whose placement recovery destroyed without replacing it. */
  releaseUnrecoverablePage?: (page: RuntimeBrowserClientPage) => void
  /** Skip newly adopted pages: inventory still names predecessor authority and would wrongly trigger their teardown. */
  adoptedPageIds?: ReadonlySet<string>
  /** Adoption owns these queued/running rows and their current attach observer. */
  claimedPageIds?: ReadonlySet<string>
  /** Re-resolve routes for persisted pages: keys name their minting runtime process and clients refuse predecessor keys. */
  resolveExecutionHostKey?: (workspaceId: string) => Promise<BrowserExecutionHostKeyResolution>
  signal?: AbortSignal
}): Promise<void> {
  const inventory = options.lease.pageInventory
  if (
    options.lease.pageReconciliationProtocolVersion !== 1 ||
    options.lease.pageInventoryProtocolVersion !== 1 ||
    !inventory
  ) {
    return
  }
  const inventoryByPageId = new Map(inventory.map((page) => [page.browserPageId, page]))
  const pages = options.pages
    .listPages()
    .filter(
      (page) =>
        isPlacedAsObservedAtAttach(page, options.pagePlacementsAtAttach) &&
        !options.adoptedPageIds?.has(page.browserPageId) &&
        !options.claimedPageIds?.has(page.browserPageId) &&
        (isRecoverableByLease(page, options.lease) ||
          options.authority.clientPageInitializations.canContinue(
            page.browserPageId,
            page.placement,
            options.lease
          )) &&
        !isActiveExactPage(page, inventoryByPageId.get(page.browserPageId), options.lease)
    )
  if (options.lease.hostCapabilities?.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY)) {
    batchBrowserPageInitializationNotifications(options.notifyWorkspace, (notifyWorkspace) => {
      for (const page of pages) {
        const previous = inventoryByPageId.get(page.browserPageId)
        admitRuntimeBrowserPageInitialization({
          ...options,
          notifyWorkspace,
          lease: options.lease,
          page,
          url: previous?.currentUrl ?? page.url,
          ...(previous ? { previous } : {}),
          resolveExecutionHostKey:
            options.resolveExecutionHostKey ??
            (async () => ({ status: 'resolved', executionHostKey: page.executionHostKey }))
        })
      }
    })
    return
  }
  await recoverClientPagesWithConcurrency(
    pages,
    MAX_RECOVERY_CONCURRENCY,
    async (page) => {
      try {
        await recoverPage(page, inventoryByPageId.get(page.browserPageId), options)
      } catch (error) {
        // Contain page-scoped failures; rejecting attach would fence the lease and healthy pages too.
        console.warn('[browser-host-lease] client page recovery failed:', {
          browserPageId: page.browserPageId,
          error
        })
        // The logical saved row remains closeable for a later authenticated recovery.
      }
    },
    options.signal
  )
}

/** Readiness precedes recovery; skip placements created since this inventory or absent entries would wrongly trigger recreation. */
function isPlacedAsObservedAtAttach(
  page: RuntimeBrowserClientPage,
  pagePlacementsAtAttach: ReadonlyMap<string, RuntimeBrowserClientPage['placement']> | undefined
): boolean {
  if (!pagePlacementsAtAttach) {
    return true
  }
  const observed = pagePlacementsAtAttach.get(page.browserPageId)
  return observed !== undefined && sameRuntimeBrowserPlacement(observed, page.placement)
}

/** Keep routes minted by this runtime; restored pages re-resolve. Retire only workspace-gone; unavailable routes leave held rows for later attach. */
async function resolveRecoveryExecutionHostKey(
  page: RuntimeBrowserClientPage,
  options: Parameters<typeof recoverUnavailableRuntimeBrowserClientPages>[0]
): Promise<string | null> {
  if (!isRestoredClientHostedBrowserPlacement(page.placement)) {
    return page.executionHostKey
  }
  const resolved = await options.resolveExecutionHostKey?.(page.workspaceId)
  if (resolved?.status === 'resolved') {
    return resolved.executionHostKey
  }
  if (resolved?.status === 'workspace-gone') {
    options.releaseUnrecoverablePage?.(page)
  }
  return null
}

async function recoverPage(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory | undefined,
  options: Parameters<typeof recoverUnavailableRuntimeBrowserClientPages>[0]
): Promise<void> {
  const executionHostKey = await resolveRecoveryExecutionHostKey(page, options)
  if (executionHostKey === null) {
    return
  }
  const currentPlacement = options.authority.getPlacement(page.browserPageId)
  if (currentPlacement && !sameRuntimeBrowserPlacement(currentPlacement, page.placement)) {
    if (
      currentPlacement.kind === 'client' &&
      currentPlacement.browserHostClientId === options.lease.browserHostClientId &&
      currentPlacement.browserHostGeneration === options.lease.browserHostGeneration
    ) {
      options.pages.replaceClientPagePlacement(page.browserPageId, page.placement, currentPlacement)
      options.notifyWorkspace(page.workspaceId)
      return
    }
    throw new Error('browser_page_placement_stale')
  }
  if (currentPlacement) {
    if (inventory) {
      assertInventoryAuthority(page, inventory, options.lease)
      await closeUnavailablePage(options.authority, page)
    } else {
      const retirement = options.authority.beginPageRetirement(page.browserPageId, currentPlacement)
      if (!options.authority.completePageRetirement(retirement)) {
        throw new Error('browser_page_placement_stale')
      }
    }
  }
  const legacyRecovery = options.authority.claimLegacyClientPageRecovery(options.lease, {
    browserPageId: page.browserPageId,
    browserProfileId: page.browserProfileId,
    workspaceId: page.workspaceId,
    expected: page.placement,
    isCurrent: () => {
      const current = options.pages.getPage(page.browserPageId)
      return Boolean(
        current &&
        current.pairedDeviceId === page.pairedDeviceId &&
        current.browserProfileId === page.browserProfileId &&
        current.workspaceId === page.workspaceId &&
        sameRuntimeBrowserPlacement(current.placement, page.placement)
      )
    }
  })
  const placement = await options.authority.createClientPage({
    browserPageId: page.browserPageId,
    browserHostClientId: options.lease.browserHostClientId,
    pairedDeviceId: options.lease.pairedDeviceId,
    browserProfileId: page.browserProfileId,
    executionHostKey,
    requiredCapabilities: [BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY],
    workspaceId: page.workspaceId,
    signal: options.signal,
    legacyRecovery,
    committed: (placement) =>
      options.pages.replaceClientPagePlacement(
        page.browserPageId,
        page.placement,
        placement,
        executionHostKey
      )
  })
  const recovered = options.pages.getPage(page.browserPageId)!
  const url = inventory?.currentUrl ?? page.url
  if (url && url !== 'about:blank') {
    await navigateRecoveredPage(options.authority, page.browserPageId, placement, url)
    options.pages.updatePage(page.browserPageId, placement, { url, loading: false })
  } else if (recovered.loading) {
    options.pages.updatePage(page.browserPageId, placement, { loading: false })
  }
  options.notifyWorkspace(page.workspaceId)
}

async function closeUnavailablePage(
  authority: RecoveryAuthority,
  page: RuntimeBrowserClientPage
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    commandAuthority(authority, page.browserPageId, page.placement),
    {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: authority.authorityRuntimeId,
        authorityEpoch: authority.authorityEpoch,
        browserHostClientId: page.placement.browserHostClientId,
        browserHostGeneration: page.placement.browserHostGeneration,
        pageHostGeneration: page.placement.pageHostGeneration
      }
    }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
  const currentPlacement = authority.getPlacement(page.browserPageId)
  if (!currentPlacement || !sameRuntimeBrowserPlacement(currentPlacement, page.placement)) {
    throw new Error('browser_page_placement_stale')
  }
  const retirement = authority.beginPageRetirement(page.browserPageId, currentPlacement)
  if (!authority.completePageRetirement(retirement)) {
    throw new Error('browser_page_placement_stale')
  }
}

async function navigateRecoveredPage(
  authority: RecoveryAuthority,
  browserPageId: string,
  placement: RuntimeBrowserClientPage['placement'],
  url: string
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    commandAuthority(authority, browserPageId, placement),
    { type: 'navigate', url }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
}

function commandAuthority(
  authority: RecoveryAuthority,
  browserPageId: string,
  placement: RuntimeBrowserClientPage['placement']
) {
  return {
    authorityRuntimeId: authority.authorityRuntimeId,
    authorityEpoch: authority.authorityEpoch,
    browserPageId,
    browserHostClientId: placement.browserHostClientId,
    browserHostGeneration: placement.browserHostGeneration,
    pageHostGeneration: placement.pageHostGeneration
  }
}
