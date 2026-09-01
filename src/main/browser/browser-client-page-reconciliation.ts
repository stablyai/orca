import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer,
  browserClientPageIdentity
} from './browser-client-page-command-admission'
import { sameBrowserClientPageAuthority } from './browser-client-host-command-authority'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import {
  createBrowserClientPageInventory,
  updateBrowserClientPageInventoryCurrentUrl
} from './browser-client-page-inventory'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'
import type { BrowserClientPageRendererIdentity } from './browser-client-page-cleanup'

type BrowserClientPageReconciliationContext = {
  pages: Map<string, BrowserClientRetainedPage>
  failedPages: Map<string, BrowserClientHostedPageInventory>
  routeWebContents: BrowserClientPageLifecycleRegistry
  assertAvailable: () => void
  createPage: (event: BrowserClientHostCommandEvent, signal: AbortSignal) => Promise<void>
  navigate: (event: BrowserClientHostCommandEvent, signal: AbortSignal) => Promise<void>
  retirePage: (browserPageId: string, pageHostGeneration: number) => Promise<boolean>
  cleanupPage: (
    page: BrowserClientRetainedPage,
    previousRendererPage?: BrowserClientPageRendererIdentity
  ) => Promise<void>
}

export function executeBrowserClientPageReconciliationCommand(
  context: BrowserClientPageReconciliationContext,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  switch (event.command.type) {
    case 'reclaimPage':
      return reclaimPage(context, event, signal)
    case 'closePage':
      return closeReconciledPage(context, event, signal)
    case 'restorePage':
      return restorePage(context, event, signal)
    case 'createPage':
    case 'navigate':
    case 'automation':
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
}

async function reclaimPage(
  context: BrowserClientPageReconciliationContext,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.command.type !== 'reclaimPage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = context.pages.get(event.browserPageId)
  if (
    !page ||
    page.retiring ||
    page.reconciling ||
    page.inventory.authorityRuntimeId !== event.authorityRuntimeId ||
    !sameBrowserClientPageAuthority(page.inventory, event.command.previousAuthority) ||
    page.inventory.browserProfileId !== event.command.browserProfileId ||
    page.inventory.executionHostKey !== event.command.executionHostKey
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
  }
  assertBrowserClientPageCommandNotAborted(signal)
  assertCurrentBrowserClientPageRenderer(page.renderer)
  context.assertAvailable()
  page.reconciling = true
  if (!context.routeWebContents.revokeNavigation(page.lifecycleClaim)) {
    page.reconciling = false
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
  }
  const previousRendererPage = browserClientPageIdentity(
    page.registration,
    page.registration.partition
  )
  const nextRegistration = { ...page.registration, pageHostGeneration: event.pageHostGeneration }
  const nextRendererPage = browserClientPageIdentity(nextRegistration, nextRegistration.partition)
  const rekeyGuestLifecycle = context.routeWebContents.rekeyGuestLifecycle
  const grantReconciledNavigation = context.routeWebContents.grantReconciledNavigation
  const rekeyRendererPage = page.renderer.rekeyPage
  if (!rekeyGuestLifecycle || !grantReconciledNavigation || !rekeyRendererPage) {
    page.reconciling = false
    if (
      !grantReconciledNavigation ||
      !grantReconciledNavigation.call(context.routeWebContents, page.lifecycleClaim)
    ) {
      await failClosedRekeyedPage(
        context,
        page,
        new BrowserClientPageCommandError('browser_client_page_reconciliation_unsupported')
      )
    }
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_unsupported')
  }
  const rekeyed = rekeyGuestLifecycle.call(
    context.routeWebContents,
    page.lifecycleClaim,
    nextRegistration
  )
  if (!rekeyed) {
    page.reconciling = false
    if (!grantReconciledNavigation.call(context.routeWebContents, page.lifecycleClaim)) {
      await failClosedRekeyedPage(
        context,
        page,
        new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
      )
    }
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
  }
  page.generation = event.pageHostGeneration
  page.registration = nextRegistration
  page.lifecycleClaim = rekeyed.lifecycleClaim
  page.routeSession = rekeyed.routeSession
  page.inventory = createReconciliationInventory(event, 'outcomeUnknown', page.inventory.currentUrl)
  try {
    await rekeyRendererPage.call(page.renderer, previousRendererPage, nextRendererPage, signal)
    assertBrowserClientPageCommandNotAborted(signal)
    context.assertAvailable()
    assertCurrentBrowserClientPageRenderer(page.renderer)
    if (!grantReconciledNavigation.call(context.routeWebContents, rekeyed.lifecycleClaim)) {
      throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
    }
    page.inventory = createReconciliationInventory(event, 'active', page.inventory.currentUrl)
    page.reconciling = false
  } catch (error) {
    await failClosedRekeyedPage(context, page, error, previousRendererPage)
  }
}

async function closeReconciledPage(
  context: BrowserClientPageReconciliationContext,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.command.type !== 'closePage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = context.pages.get(event.browserPageId)
  if (
    !page ||
    page.retiring ||
    page.reconciling ||
    event.pageHostGeneration !== event.command.targetAuthority.pageHostGeneration ||
    !sameBrowserClientPageAuthority(page.inventory, event.command.targetAuthority)
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
  }
  assertBrowserClientPageCommandNotAborted(signal)
  if (!(await context.retirePage(event.browserPageId, page.generation))) {
    throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
  }
}

async function restorePage(
  context: BrowserClientPageReconciliationContext,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.command.type !== 'restorePage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  await context.createPage(reconciliationCreateEvent(event), signal)
  if (!event.command.url) {
    return
  }
  try {
    await context.navigate(
      { ...event, command: { type: 'navigate', url: event.command.url } },
      signal
    )
  } catch (error) {
    try {
      await context.retirePage(event.browserPageId, event.pageHostGeneration)
    } catch (cleanupError) {
      throw new BrowserClientPageCommandError('browser_client_page_cleanup_failed', {
        cause: new AggregateError([error, cleanupError], 'Browser page restore failed')
      })
    }
    throw error
  }
}

async function failClosedRekeyedPage(
  context: BrowserClientPageReconciliationContext,
  page: BrowserClientRetainedPage,
  error: unknown,
  previousRendererPage?: BrowserClientPageRendererIdentity
): Promise<never> {
  page.reconciling = false
  page.retiring ??= context.cleanupPage(page, previousRendererPage)
  try {
    await page.retiring
    if (context.pages.get(page.inventory.browserPageId) === page) {
      context.pages.delete(page.inventory.browserPageId)
    }
  } catch (cleanupError) {
    context.pages.delete(page.inventory.browserPageId)
    context.failedPages.set(page.inventory.browserPageId, page.inventory)
    throw new BrowserClientPageCommandError('browser_client_page_cleanup_failed', {
      cause: new AggregateError([error, cleanupError], 'Browser page reclaim failed')
    })
  }
  throw error
}

function reconciliationCreateEvent(
  event: BrowserClientHostCommandEvent
): BrowserClientHostCommandEvent {
  if (event.command.type !== 'reclaimPage' && event.command.type !== 'restorePage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  return {
    ...event,
    command: {
      type: 'createPage',
      browserProfileId: event.command.browserProfileId,
      executionHostKey: event.command.executionHostKey,
      ...(event.command.workspaceId ? { workspaceId: event.command.workspaceId } : {})
    }
  }
}

function createReconciliationInventory(
  event: BrowserClientHostCommandEvent,
  state: BrowserClientHostedPageInventory['state'],
  currentUrl?: string
): BrowserClientHostedPageInventory {
  const inventory = createBrowserClientPageInventory(reconciliationCreateEvent(event), state)
  return currentUrl ? updateBrowserClientPageInventoryCurrentUrl(inventory, currentUrl) : inventory
}
