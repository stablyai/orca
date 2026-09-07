import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { isBrowserClientHostAuthorityReplaced } from './browser-client-host-authority-replacement'
import { BrowserClientHostAuthorityReplacementWait } from './browser-client-host-authority-replacement-wait'
import {
  asCompositionError,
  closeBrowserClientHostComposition
} from './paired-runtime-browser-client-host-teardown'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import type { BrowserClientPageAuthorityIdentity as BrowserClientHostAuthorityTransitionInput } from './browser-client-page-command-executor-dependencies'
import {
  type ComposedBrowserClientNetworkRoutes,
  PairedRuntimeBrowserClientHostRouteSets
} from './paired-runtime-browser-client-host-route-sets'

type ComposedPageExecutor = {
  handle(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  hasUnresolvedPage(browserPageId: string, pageHostGeneration: number): boolean
  snapshotPageInventory(): readonly BrowserClientHostedPageInventory[]
  beginAuthorityTransition(): void
  completeAuthorityTransition(input: BrowserClientHostAuthorityTransitionInput): void
  fenceNavigation(): void
  close(): Promise<void>
}

type ComposedClientHost = {
  start(): Promise<BrowserClientHostLeaseAuthority>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  forgetPage(browserPageId: string, pageHostGeneration: number): boolean
  whenHandlersSettled(): Promise<void>
  refreshPageInventory(): Promise<void>
  close(error?: Error): Promise<boolean>
}

type ClientHostCallbacks = {
  handler(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult>
  onAuthority(authority: BrowserClientHostLeaseAuthority): void
  getPageInventory(): readonly BrowserClientHostedPageInventory[]
  onError(error: Error): void
  onTransportLost(error: Error): void
  onReconnected(authority: BrowserClientHostLeaseAuthority): void
}

type PairedRuntimeBrowserClientHostCompositionOptions<
  Start extends BrowserClientHostAuthorityTransitionInput
> = {
  initialInput: Start
  createRoutes(
    input: Start,
    authority: BrowserClientHostLeaseAuthority
  ): ComposedBrowserClientNetworkRoutes
  createExecutor(
    input: Start,
    options: {
      retainNetworkRoute(
        executionHostKey: string,
        signal: AbortSignal
      ): Promise<BrowserClientPageNetworkRoute>
      onPageUnavailable(browserPageId: string, pageHostGeneration: number): void
    }
  ): ComposedPageExecutor
  createHost(input: Start, callbacks: ClientHostCallbacks): ComposedClientHost
  onError?: (error: Error) => void
  /** Runs as closing begins, before teardown: the point after which this composition owns nothing. */
  onClosing?: () => void
  /** Injected so the grace a restart depends on is drivable; production supplies the real deadline. */
  createAuthorityReplacementWait?: () => BrowserClientHostAuthorityReplacementWait
}

export class PairedRuntimeBrowserClientHostComposition<
  Start extends BrowserClientHostAuthorityTransitionInput
> {
  private readonly executor: ComposedPageExecutor
  private host: ComposedClientHost
  private readonly routeSets: PairedRuntimeBrowserClientHostRouteSets<Start>
  private startPromise: Promise<BrowserClientHostLeaseAuthority> | null = null
  private closePromise: Promise<boolean> | null = null
  private deferredExecutorClose: Promise<void> | null = null
  private hostGeneration = 0
  private closed = false
  private errorReported = false
  private inventoryRefreshPromise: Promise<void> | null = null
  private readonly authorityReplacementWait: BrowserClientHostAuthorityReplacementWait

  constructor(private readonly options: PairedRuntimeBrowserClientHostCompositionOptions<Start>) {
    this.authorityReplacementWait =
      options.createAuthorityReplacementWait?.() ?? new BrowserClientHostAuthorityReplacementWait()
    this.routeSets = new PairedRuntimeBrowserClientHostRouteSets({
      createRoutes: options.createRoutes,
      onRecoveryError: (error) => this.handleHostError(error),
      onCleanupError: (error) => this.handleHostError(error)
    })
    this.executor = options.createExecutor(options.initialInput, {
      retainNetworkRoute: (key, signal) => this.routeSets.retain(key, signal),
      onPageUnavailable: () => this.requestPageInventoryRefresh()
    })
    this.host = this.createHost(options.initialInput, false)
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_composition_closed'))
    }
    this.startPromise ??= this.host.start()
    return this.startPromise
  }

  replaceAuthority(input: Start): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_composition_closed'))
    }
    const error = new Error('Browser client host runtime authority was replaced')
    this.authorityReplacementWait.cancel()
    this.hostGeneration += 1
    try {
      this.routeSets.retireCurrent(error)
      this.executor.beginAuthorityTransition()
    } catch (transitionError) {
      return Promise.reject(transitionError)
    }
    this.startPromise = this.finishAuthorityReplacement(input, error)
    return this.startPromise
  }

  async retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    if (this.closed) {
      throw new Error('paired_runtime_browser_client_host_composition_closed')
    }
    if (!(await this.host.retirePage(browserPageId, pageHostGeneration))) {
      return false
    }
    if (
      !(await this.executor.retirePage(browserPageId, pageHostGeneration)) &&
      this.executor.hasUnresolvedPage(browserPageId, pageHostGeneration)
    ) {
      throw new Error('browser_client_page_retirement_cleanup_pending')
    }
    if (!this.host.forgetPage(browserPageId, pageHostGeneration)) {
      throw new Error('browser_client_page_retirement_forget_failed')
    }
    return true
  }

  close(error = new Error('Browser client host composition is closed')): Promise<boolean> {
    if (!this.closed) {
      this.closed = true
      this.authorityReplacementWait.cancel()
      this.hostGeneration += 1
      try {
        this.options.onClosing?.()
      } catch (closingError) {
        this.reportCleanupError(asCompositionError(closingError))
      }
      this.fenceTerminalAuthority(error)
    }
    this.closePromise ??= this.closeComposition(error)
    return this.closePromise
  }

  async whenClosed(): Promise<void> {
    if (!this.closePromise) {
      throw new Error('paired_runtime_browser_client_host_composition_open')
    }
    await this.closePromise
    await this.deferredExecutorClose
  }

  private createHost(input: Start, requiresReconciliation: boolean): ComposedClientHost {
    const generation = ++this.hostGeneration
    let publishedInventory: readonly BrowserClientHostedPageInventory[] | null = null
    return this.options.createHost(input, {
      handler: (event, signal) => this.handleCommand(generation, event, signal),
      getPageInventory: () => {
        if (this.hostGeneration !== generation) {
          return []
        }
        publishedInventory = this.executor.snapshotPageInventory()
        return publishedInventory
      },
      onAuthority: (authority) => {
        if (this.hostGeneration === generation) {
          if (
            requiresReconciliation &&
            publishedInventory?.length &&
            authority.pageReconciliationProtocolVersion !== 1
          ) {
            throw new Error('browser_client_page_reconciliation_unsupported')
          }
          this.routeSets.activate(input, authority)
        }
      },
      onTransportLost: (error) => {
        if (this.hostGeneration === generation) {
          this.routeSets.suspend(error)
        }
      },
      onReconnected: (authority) => {
        if (this.hostGeneration === generation) {
          this.routeSets.reconnect(authority)
        }
      },
      // A replaced authority is armed rather than handled: handleHostError would close the
      // composition and latch `errorReported`, swallowing the next genuinely fatal error.
      onError: (error) => {
        const fatal = (): void => {
          if (!this.closed && this.hostGeneration === generation) {
            this.handleHostError(error)
          }
        }
        if (this.hostGeneration !== generation) {
          return
        }
        if (this.closed || !isBrowserClientHostAuthorityReplaced(error)) {
          this.handleHostError(error)
          return
        }
        this.authorityReplacementWait.arm(fatal)
      }
    })
  }

  private async finishAuthorityReplacement(
    input: Start,
    error: Error
  ): Promise<BrowserClientHostLeaseAuthority> {
    const previousHost = this.host
    const settled = await previousHost.close(error)
    if (!settled) {
      await previousHost.whenHandlersSettled()
    }
    if (this.closed) {
      throw new Error('paired_runtime_browser_client_host_composition_closed')
    }
    this.executor.completeAuthorityTransition(input)
    const replacementHost = this.createHost(input, true)
    this.host = replacementHost
    return replacementHost.start()
  }

  private async handleCommand(
    generation: number,
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult> {
    if (this.hostGeneration !== generation) {
      throw new Error('browser_client_host_command_aborted')
    }
    await this.routeSets.waitForRecovery(signal)
    if (this.closed || signal.aborted || this.hostGeneration !== generation) {
      throw new Error('browser_client_host_command_aborted')
    }
    return this.executor.handle(event, signal)
  }

  private requestPageInventoryRefresh(): void {
    if (this.closed || this.inventoryRefreshPromise) {
      return
    }
    const refresh = this.host.refreshPageInventory()
    this.inventoryRefreshPromise = refresh
    void refresh
      .catch((error) => this.handleHostError(asCompositionError(error)))
      .finally(() => {
        if (this.inventoryRefreshPromise === refresh) {
          this.inventoryRefreshPromise = null
        }
      })
  }

  private fenceTerminalAuthority(error: Error): void {
    this.routeSets.fence(error)
    try {
      this.executor.fenceNavigation()
    } catch (navigationError) {
      this.reportCleanupError(asCompositionError(navigationError))
    }
  }

  private closeComposition(error: Error): Promise<boolean> {
    return closeBrowserClientHostComposition({
      host: this.host,
      executor: this.executor,
      routeSets: this.routeSets,
      error,
      deferExecutorClose: (close) => {
        this.deferredExecutorClose = close
      },
      reportCleanupError: (cleanupError) => this.reportCleanupError(cleanupError)
    })
  }

  private handleHostError(error: Error): void {
    void this.close(error).catch((closeError) => this.reportError(asCompositionError(closeError)))
    this.reportError(error)
  }

  private reportError(error: Error): void {
    if (this.errorReported) {
      return
    }
    this.errorReported = true
    try {
      this.options.onError?.(error)
    } catch {}
  }

  private reportCleanupError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {}
  }
}
