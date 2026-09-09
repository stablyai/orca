import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH,
  BrowserClientHostedPageInventoryList,
  browserClientHostedPageInventoryByteLength,
  type BrowserClientHostedPageInventory,
  type BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import { BrowserClientPageMetadataParams } from '../../shared/browser-client-page-metadata-protocol'
import type { BrowserClientPageRenderer } from './browser-client-page-cleanup'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import type { BrowserRouteGuestLifecycleClaim } from './browser-route-page-authority'

export function createBrowserClientPageInventory(
  event: BrowserClientHostCommandEvent,
  state: BrowserClientHostedPageInventory['state']
): BrowserClientHostedPageInventory {
  if (event.command.type !== 'createPage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  return Object.freeze({
    authorityRuntimeId: event.authorityRuntimeId,
    authorityEpoch: event.authorityEpoch,
    browserHostClientId: event.browserHostClientId,
    browserHostGeneration: event.browserHostGeneration,
    browserPageId: event.browserPageId,
    pageHostGeneration: event.pageHostGeneration,
    browserProfileId: event.command.browserProfileId,
    executionHostKey: event.command.executionHostKey,
    state,
    ...(event.command.workspaceId ? { workspaceId: event.command.workspaceId } : {})
  })
}

export function snapshotBrowserClientPageInventory(
  inventory: BrowserClientHostedPageInventory,
  renderer: BrowserClientPageRenderer,
  lifecycleClaim: BrowserRouteGuestLifecycleClaim,
  forceOutcomeUnknown = false
): BrowserClientHostedPageInventory {
  return Object.freeze({
    ...inventory,
    state:
      !forceOutcomeUnknown &&
      inventory.state === 'active' &&
      browserClientPageRendererIsCurrent(renderer) &&
      browserRouteGuestLifecycleClaimIsCurrent(lifecycleClaim)
        ? 'active'
        : 'outcomeUnknown'
  })
}

export function snapshotBrowserClientPageInventoryList(
  creatingPages: ReadonlyMap<string, BrowserClientHostedPageInventory>,
  retainedPages: Iterable<{
    inventory: BrowserClientHostedPageInventory
    lifecycleClaim: BrowserRouteGuestLifecycleClaim
    renderer: BrowserClientPageRenderer
    retiring: Promise<void> | null
    reconciling: boolean
  }>,
  failedPages: ReadonlyMap<string, BrowserClientHostedPageInventory>
): readonly BrowserClientHostedPageInventory[] {
  const inventoryByPageId = new Map(creatingPages)
  for (const page of retainedPages) {
    inventoryByPageId.set(
      page.inventory.browserPageId,
      snapshotBrowserClientPageInventory(
        page.inventory,
        page.renderer,
        page.lifecycleClaim,
        page.retiring !== null || page.reconciling
      )
    )
  }
  for (const page of failedPages.values()) {
    inventoryByPageId.set(page.browserPageId, page)
  }
  return Object.freeze(
    [...inventoryByPageId.values()].sort((left, right) =>
      left.browserPageId < right.browserPageId
        ? -1
        : left.browserPageId > right.browserPageId
          ? 1
          : 0
    )
  )
}

export function prepareBrowserClientPageInventoryForAttach(
  pages: readonly BrowserClientHostedPageInventory[]
): readonly BrowserClientHostedPageInventory[] | undefined {
  if (pages.length > BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES) {
    return undefined
  }
  const inventory: BrowserClientHostedPageInventory[] = []
  for (const page of pages) {
    const parsed = BrowserClientHostedPageInventoryList.element.safeParse(page)
    if (!parsed.success) {
      return undefined
    }
    inventory.push(parsed.data)
  }
  let inventoryBytes = browserClientHostedPageInventoryByteLength(inventory)
  const optionalUrls = inventory
    .flatMap((page, index) => {
      if (page.currentUrl === undefined) {
        return []
      }
      const withoutUrl = omitBrowserClientPageInventoryUrl(page)
      return [
        {
          browserPageId: page.browserPageId,
          index,
          savings:
            browserClientHostedPageInventoryByteLength([page]) -
            browserClientHostedPageInventoryByteLength([withoutUrl]),
          withoutUrl
        }
      ]
    })
    .sort(
      (left, right) =>
        right.savings - left.savings ||
        compareBrowserPageIds(left.browserPageId, right.browserPageId)
    )
  for (const candidate of optionalUrls) {
    if (inventoryBytes <= BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES) {
      break
    }
    inventory[candidate.index] = candidate.withoutUrl
    inventoryBytes -= candidate.savings
  }
  const prepared = BrowserClientHostedPageInventoryList.safeParse(inventory)
  return prepared.success ? prepared.data : undefined
}

/**
 * Records where a guest actually is, from the metadata publish that reports every navigation.
 *
 * Without this the inventory only ever names URLs the runtime navigated to, so a page the user
 * browsed away from -- a link, a form, a redirect -- would be restored at the address it was
 * opened with rather than where they left it.
 */
export function recordBrowserClientPagePublishedUrl(
  pages: ReadonlyMap<string, { generation: number; inventory: BrowserClientHostedPageInventory }>,
  params: unknown
): void {
  const metadata = BrowserClientPageMetadataParams.safeParse(params)
  if (!metadata.success) {
    return
  }
  const page = pages.get(metadata.data.browserPageId)
  if (!page || page.generation !== metadata.data.pageHostGeneration) {
    return
  }
  page.inventory = updateBrowserClientPageInventoryCurrentUrl(page.inventory, metadata.data.url)
}

export function updateBrowserClientPageInventoryCurrentUrl(
  inventory: BrowserClientHostedPageInventory,
  currentUrl: string
): BrowserClientHostedPageInventory {
  if (currentUrl.length > BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH) {
    return Object.freeze(omitBrowserClientPageInventoryUrl(inventory))
  }
  return Object.freeze({ ...inventory, currentUrl })
}

function omitBrowserClientPageInventoryUrl(
  inventory: BrowserClientHostedPageInventory
): BrowserClientHostedPageInventory {
  const withoutUrl = { ...inventory }
  delete withoutUrl.currentUrl
  return withoutUrl
}

function browserClientPageRendererIsCurrent(renderer: BrowserClientPageRenderer): boolean {
  try {
    return renderer.isCurrent()
  } catch {
    return false
  }
}

function browserRouteGuestLifecycleClaimIsCurrent(
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
): boolean {
  try {
    return lifecycleClaim.isCurrent()
  } catch {
    return false
  }
}

function compareBrowserPageIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
