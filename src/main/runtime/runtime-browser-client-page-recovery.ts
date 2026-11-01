import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import type { BrowserHostLeaseRegistry } from './browser-host/browser-host-lease-registry'
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
> & {
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
        isRecoverableByLease(page, options.lease) &&
        !isActiveExactPage(page, inventoryByPageId.get(page.browserPageId), options.lease)
    )
  await mapWithConcurrency(
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
        releaseUnhostablePage(page, options)
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

/** Retained pages match client identity across generations. Restored pages match paired device because client ids rotate per process.
 * Device matching prevents another or revoked/re-paired device from inheriting tabs; unmatched rows stay host-absent and closeable. */
function isRecoverableByLease(
  page: RuntimeBrowserClientPage,
  lease: BrowserClientHostLeaseAuthority & { pairedDeviceId: string }
): boolean {
  if (isRestoredClientHostedBrowserPlacement(page.placement)) {
    return page.pairedDeviceId === lease.pairedDeviceId
  }
  return (
    page.placement.browserHostClientId === lease.browserHostClientId &&
    page.placement.browserHostGeneration <= lease.browserHostGeneration
  )
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

/** Retires a page left with no placement at all; anything still placed can retry on a later attach. */
function releaseUnhostablePage(
  page: RuntimeBrowserClientPage,
  options: Parameters<typeof recoverUnavailableRuntimeBrowserClientPages>[0]
): void {
  if (options.authority.getPlacement(page.browserPageId)) {
    return
  }
  options.releaseUnrecoverablePage?.(page)
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
  const placement = await options.authority.createClientPage({
    browserPageId: page.browserPageId,
    browserHostClientId: options.lease.browserHostClientId,
    pairedDeviceId: options.lease.pairedDeviceId,
    browserProfileId: page.browserProfileId,
    executionHostKey,
    requiredCapabilities: [BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY],
    workspaceId: page.workspaceId
  })
  const recovered = options.pages.replaceClientPagePlacement(
    page.browserPageId,
    page.placement,
    placement,
    executionHostKey
  )
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

function isActiveExactPage(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory | undefined,
  lease: BrowserClientHostLeaseAuthority
): boolean {
  return Boolean(
    inventory?.state === 'active' &&
    inventory.authorityRuntimeId === lease.authorityRuntimeId &&
    inventory.authorityEpoch === lease.authorityEpoch &&
    inventory.browserHostClientId === page.placement.browserHostClientId &&
    inventory.browserHostGeneration === page.placement.browserHostGeneration &&
    inventory.pageHostGeneration === page.placement.pageHostGeneration &&
    inventory.browserProfileId === page.browserProfileId &&
    inventory.executionHostKey === page.executionHostKey
  )
}

function assertInventoryAuthority(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory,
  lease: BrowserClientHostLeaseAuthority
): void {
  if (
    inventory.authorityRuntimeId !== lease.authorityRuntimeId ||
    inventory.authorityEpoch !== lease.authorityEpoch ||
    inventory.browserHostClientId !== page.placement.browserHostClientId ||
    inventory.browserHostGeneration !== page.placement.browserHostGeneration ||
    inventory.pageHostGeneration !== page.placement.pageHostGeneration
  ) {
    throw new Error('browser_client_page_reconciliation_authority_stale')
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < values.length && !signal?.aborted) {
      const value = values[index]
      index += 1
      if (value !== undefined) {
        await operation(value)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
}
