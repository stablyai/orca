import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientProfileMetadata } from '../../shared/browser-client-profile-switch-protocol'
import { sameBrowserClientPageAuthority } from './browser-client-host-command-authority'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer
} from './browser-client-page-command-admission'
import {
  BrowserClientPageCommandError,
  isBrowserClientPageCleanupFailure
} from './browser-client-page-command-failure'
import type { BrowserClientPageCommandExecutorDependencies } from './browser-client-page-command-executor-dependencies'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from './browser-client-page-inventory'
import { markBrowserClientPageUnavailable } from './browser-client-page-availability'

export async function switchBrowserClientPageProfile(input: {
  event: BrowserClientHostCommandEvent
  signal: AbortSignal
  switches: BrowserClientProfileSwitches
  pages: Map<string, BrowserClientRetainedPage>
  dependencies: BrowserClientPageCommandExecutorDependencies
  assertAvailable(): void
  commit(page: BrowserClientRetainedPage): void
  cleanup(page: BrowserClientRetainedPage, releaseUploads: boolean): Promise<void>
}): Promise<void> {
  const { event, signal, dependencies, switches } = input
  if (event.command.type !== 'switchProfile') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const old = input.pages.get(event.browserPageId)
  if (
    !old ||
    old.retiring ||
    old.reconciling ||
    !sameBrowserClientPageAuthority(old.inventory, event) ||
    event.command.nextPageHostGeneration <= old.generation
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
  }
  const profile = BrowserClientProfileMetadata.parse(event.command.profile)
  const bindReplacement = dependencies.guestBinding.bindReplacement
  if (!bindReplacement) {
    throw new BrowserClientPageCommandError('browser_client_page_profile_switch_unsupported')
  }
  if (profile.id === old.inventory.browserProfileId) {
    throw new BrowserClientPageCommandError('browser_client_page_profile_switch_redundant')
  }
  const create: BrowserClientHostCommandEvent = {
    ...event,
    pageHostGeneration: event.command.nextPageHostGeneration,
    command: {
      type: 'createPage',
      browserProfileId: profile.id,
      profile,
      executionHostKey: old.inventory.executionHostKey,
      ...(old.inventory.workspaceId ? { workspaceId: old.inventory.workspaceId } : {})
    }
  }
  let staged: BrowserClientRetainedPage | undefined
  let bindingAttempted = false
  old.reconciling = true
  switches.stagedPages.set(event.browserPageId, null)
  try {
    await createReservedBrowserClientPage(
      {
        ...dependencies,
        // A profile switch cannot change the execution route or supersede the old guest.
        retireSupersededExecutionHostPages: async () => {},
        guestBinding: { bind: () => {}, release: () => {} }
      },
      create,
      signal,
      input.assertAvailable,
      (page) => {
        staged = page
        switches.stagedPages.set(event.browserPageId, page)
      }
    )
    if (!staged || staged.registration.partition === old.registration.partition) {
      throw new BrowserClientPageCommandError('browser_client_page_profile_partition_conflict')
    }
    assertBrowserClientPageCommandNotAborted(signal)
    input.assertAvailable()
    assertCurrentBrowserClientPageRenderer(old.renderer)
    await dependencies.retireAutomation({
      keepGuestBinding: true,
      browserPageId: event.browserPageId,
      pageHostGeneration: old.generation,
      registration: old.registration
    })
    // Fencing during automation retirement must stop the staged guest before navigation.
    assertBrowserClientPageCommandNotAborted(signal)
    input.assertAvailable()
    assertCurrentBrowserClientPageRenderer(staged.renderer)
    bindingAttempted = true
    bindReplacement({
      registration: staged.registration,
      browserProfileId: profile.id
    })
    const url = old.inventory.currentUrl
    if (url && url !== 'about:blank') {
      if (!(await dependencies.routeWebContents.navigateGuest(staged.lifecycleClaim, url))) {
        throw new BrowserClientPageCommandError('browser_client_page_navigation_failed')
      }
      staged.inventory = updateBrowserClientPageInventoryCurrentUrl(staged.inventory, url)
    }
    assertBrowserClientPageCommandNotAborted(signal)
    input.assertAvailable()
    assertCurrentBrowserClientPageRenderer(staged.renderer)
    if (
      input.pages.get(event.browserPageId) !== old ||
      !old.lifecycleClaim.isCurrent() ||
      !staged.lifecycleClaim.isCurrent()
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
    }
    input.commit(staged)
  } catch (error) {
    const oldAlive = old.lifecycleClaim.isCurrent()
    try {
      if (bindingAttempted && oldAlive) {
        // Rebind first: releasing the staged binding would otherwise cancel the page's downloads.
        dependencies.guestBinding.bind({
          registration: old.registration,
          browserProfileId: old.inventory.browserProfileId
        })
      }
      if (staged) {
        const cleanup = input.cleanup(staged, false)
        switches.retainedCleanups.add(cleanup)
        await cleanup
        switches.retainedCleanups.delete(cleanup)
      } else if (isBrowserClientPageCleanupFailure(error)) {
        // Retain staging failures so close() reports unreleased resources.
        const unresolved = Promise.reject(error)
        unresolved.catch(() => {})
        switches.retainedCleanups.add(unresolved)
      }
    } finally {
      switches.stagedPages.delete(event.browserPageId)
      old.reconciling = false
      if (!old.lifecycleClaim.isCurrent()) {
        // Reconciliation suppressed the original loss notification; report it now.
        markBrowserClientPageUnavailable(input.pages, old.registration, (id, generation) =>
          dependencies.onPageUnavailable?.(id, generation)
        )
      }
    }
    throw error
  }
  switches.stagedPages.delete(event.browserPageId)
  old.reconciling = false
  await switches.retire(old, (page) => input.cleanup(page, true))
}

export class BrowserClientProfileSwitches {
  readonly retainedCleanups = new Set<Promise<void>>()
  /** Null reserves a switch before its staged guest mounts. */
  readonly stagedPages = new Map<string, BrowserClientRetainedPage | null>()

  // Staged guests already hold navigation grants and own downloads.
  withStagedPages(pages: Iterable<BrowserClientRetainedPage>): BrowserClientRetainedPage[] {
    return [...pages, ...[...this.stagedPages.values()].filter((page) => page !== null)]
  }

  async retire(
    page: BrowserClientRetainedPage,
    cleanupPage: (page: BrowserClientRetainedPage) => Promise<void>
  ): Promise<void> {
    const cleanup = cleanupPage(page)
    this.retainedCleanups.add(cleanup)
    try {
      await cleanup
      this.retainedCleanups.delete(cleanup)
    } catch (error) {
      console.warn('[browser-client-page] Replaced guest cleanup remains unresolved', error)
    }
  }
}
