import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import { publishBrowserClientRetainedPage } from '../lifecycle/browser-client-page-availability'
import {
  type BrowserClientProfileSwitches,
  switchBrowserClientPageProfile
} from '../lifecycle/browser-client-page-profile-switch'
import { executeBrowserClientPageReconciliationCommand } from '../lifecycle/browser-client-page-reconciliation'
import type { BrowserClientRetainedPage } from '../lifecycle/browser-client-page-retained-state'
import {
  executeBrowserClientPageAutomationCommand,
  navigateBrowserClientPageCommand
} from './browser-client-page-command-execution'
import type {
  BrowserClientPageAuthorityIdentity,
  BrowserClientPageCommandExecutorDependencies
} from './browser-client-page-command-executor-dependencies'
import type { BrowserClientPageInitializations } from './browser-client-page-initializations'

/** The executor state a page command reads; the executor owns every map and lifecycle in it. */
export type BrowserClientPageCommandRoute = {
  dependencies: BrowserClientPageCommandExecutorDependencies
  authority: BrowserClientPageAuthorityIdentity
  pages: Map<string, BrowserClientRetainedPage>
  failedPages: Map<string, BrowserClientHostedPageInventory>
  initializers: BrowserClientPageInitializations
  profileSwitches: BrowserClientProfileSwitches
  assertAvailable(): void
  createPage(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  cleanupPage(
    page: BrowserClientRetainedPage,
    previousRendererPage?: Readonly<BrowserClientPageRendererIdentity>,
    releaseUploads?: boolean
  ): Promise<void>
}

export function routeBrowserClientPageCommand(
  route: BrowserClientPageCommandRoute,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<unknown> {
  const { dependencies, pages, initializers } = route
  switch (event.command.type) {
    case 'switchProfile':
      return switchBrowserClientPageProfile({
        event,
        signal,
        switches: route.profileSwitches,
        pages,
        dependencies: {
          ...dependencies,
          ...route.authority
        },
        assertAvailable: route.assertAvailable,
        commit: (page) => publishBrowserClientRetainedPage(dependencies, pages, page),
        cleanup: (page, releaseUploads) => route.cleanupPage(page, undefined, releaseUploads)
      })
    case 'createPage':
      return route.createPage(event, signal)
    case 'navigate':
      if (initializers.has(event.browserPageId)) {
        return initializers.initialize(event, signal)
      }
      return navigateBrowserClientPageCommand(pages, dependencies.routeWebContents, event, signal)
    case 'automation':
      return executeBrowserClientPageAutomationCommand(
        pages,
        dependencies.executeAutomation,
        event,
        signal,
        dependencies
      )
    case 'reclaimPage':
      return reconcilePage(route, event, signal)
    case 'closePage':
      if (initializers.ownsClose(event)) {
        return initializers.close(event, signal)
      }
      return reconcilePage(route, event, signal)
    case 'restorePage':
      return reconcilePage(route, event, signal)
  }
}

function reconcilePage(
  route: BrowserClientPageCommandRoute,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  const { pages, dependencies } = route
  return executeBrowserClientPageReconciliationCommand(
    {
      pages,
      failedPages: route.failedPages,
      routeWebContents: dependencies.routeWebContents,
      assertAvailable: route.assertAvailable,
      createPage: route.createPage,
      navigate: (command, commandSignal) =>
        navigateBrowserClientPageCommand(
          pages,
          dependencies.routeWebContents,
          command,
          commandSignal
        ),
      retirePage: route.retirePage,
      cleanupPage: (page, previousRendererPage) => route.cleanupPage(page, previousRendererPage)
    },
    event,
    signal
  )
}
