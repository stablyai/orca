import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostedPageInventory
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientRetainedPage } from '../lifecycle/browser-client-page-retained-state'
import type {
  BrowserClientPageAuthorityIdentity,
  BrowserClientPageCommandExecutorDependencies
} from './browser-client-page-command-executor-dependencies'
import {
  BrowserClientPageCommandError,
  isBrowserClientPageCleanupFailure
} from './browser-client-page-command-failure'
import type {
  BrowserClientPageInitializations,
  PageInitialization
} from './browser-client-page-initializations'
import { assertBrowserClientPageAdmission } from '../lifecycle/browser-client-page-admission'
import { createBrowserClientPageInventory } from '../lifecycle/browser-client-page-inventory'
import { createReservedBrowserClientPage } from '../lifecycle/browser-client-page-creation'
import { retireSupersededExecutionHostPages } from '../lifecycle/browser-client-page-execution-host-supersession'
import { publishBrowserClientRetainedPage } from '../lifecycle/browser-client-page-availability'

export class BrowserClientExecutorPageCreation {
  constructor(
    private readonly dependencies: BrowserClientPageCommandExecutorDependencies,
    private readonly authority: BrowserClientPageAuthorityIdentity,
    private readonly pages: Map<string, BrowserClientRetainedPage>,
    private readonly creatingPages: Map<string, BrowserClientHostedPageInventory>,
    private readonly failedPages: Map<string, BrowserClientHostedPageInventory>,
    private readonly initializers: BrowserClientPageInitializations,
    private readonly maxPages: number,
    private readonly assertAvailable: () => void,
    private readonly retirePage: (id: string, generation: number) => Promise<boolean>
  ) {}
  async createPage(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    if (event.command.type !== 'createPage') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    assertBrowserClientPageAdmission(
      [this.pages, this.creatingPages, this.failedPages],
      this.maxPages,
      event.browserPageId
    )
    const unknownInventory = createBrowserClientPageInventory(event, 'outcomeUnknown')
    this.creatingPages.set(event.browserPageId, unknownInventory)
    const initializer = this.initializers.begin(event)
    try {
      const initializationSignal = initializer?.controller?.signal
      const creation = this.createReservedPage(
        event,
        initializationSignal ? AbortSignal.any([signal, initializationSignal]) : signal,
        initializer
      )
      if (initializer) {
        initializer.creation = creation
      }
      await creation
    } catch (error) {
      if (initializer && !isBrowserClientPageCleanupFailure(error)) {
        await this.initializers.creationFailed(initializer)
      }
      if (isBrowserClientPageCleanupFailure(error)) {
        this.failedPages.set(event.browserPageId, unknownInventory)
      }
      throw error
    } finally {
      this.creatingPages.delete(event.browserPageId)
    }
  }

  private async createReservedPage(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal,
    initializer?: PageInitialization
  ): Promise<void> {
    await createReservedBrowserClientPage(
      {
        ...this.dependencies,
        ...this.authority,
        ...(initializer
          ? {
              retainFailedCleanup: (cleanup: () => Promise<void>) => {
                initializer.failedCleanup = cleanup
              }
            }
          : {}),
        retireSupersededExecutionHostPages: (route) =>
          retireSupersededExecutionHostPages(this.pages.values(), route, (id, generation) =>
            this.retirePage(id, generation)
          )
      },
      event,
      signal,
      this.assertAvailable,
      (page) => {
        if (initializer) {
          initializer.page = page
        }
        publishBrowserClientRetainedPage(
          this.dependencies,
          this.pages,
          page,
          initializer ? () => initializer.controller?.abort() : undefined
        )
      }
    )
  }
}
