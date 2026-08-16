import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'

type ComposedNetworkRoutes = {
  retain(key: string, signal: AbortSignal): Promise<BrowserClientPageNetworkRoute>
  close(error?: Error): Promise<void>
}

type ComposedPageExecutor = {
  handle(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  hasUnresolvedPage(browserPageId: string, pageHostGeneration: number): boolean
  close(): Promise<void>
}

type ComposedClientHost = {
  start(): Promise<BrowserClientHostLeaseAuthority>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  forgetPage(browserPageId: string, pageHostGeneration: number): boolean
  whenHandlersSettled(): Promise<void>
  close(error?: Error): Promise<boolean>
}

type PairedRuntimeBrowserClientHostCompositionOptions = {
  createRoutes(authority: BrowserClientHostLeaseAuthority): ComposedNetworkRoutes
  createExecutor(options: {
    retainNetworkRoute(
      executionHostKey: string,
      signal: AbortSignal
    ): Promise<BrowserClientPageNetworkRoute>
  }): ComposedPageExecutor
  createHost(options: {
    handler(
      event: BrowserClientHostCommandEvent,
      signal: AbortSignal
    ): Promise<BrowserClientHostCommandResult>
    onAuthority(authority: BrowserClientHostLeaseAuthority): void
    onError(error: Error): void
  }): ComposedClientHost
  onError?: (error: Error) => void
}

export class PairedRuntimeBrowserClientHostComposition {
  private readonly executor: ComposedPageExecutor
  private readonly host: ComposedClientHost
  private routes: ComposedNetworkRoutes | null = null
  private startPromise: Promise<BrowserClientHostLeaseAuthority> | null = null
  private closePromise: Promise<boolean> | null = null
  private deferredExecutorClose: Promise<void> | null = null
  private closed = false
  private errorReported = false

  constructor(private readonly options: PairedRuntimeBrowserClientHostCompositionOptions) {
    this.executor = options.createExecutor({
      retainNetworkRoute: (key, signal) => this.requireRoutes().retain(key, signal)
    })
    this.host = options.createHost({
      handler: (event, signal) => this.executor.handle(event, signal),
      onAuthority: (authority) => this.activateRoutes(authority),
      onError: (error) => this.handleHostError(error)
    })
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_composition_closed'))
    }
    this.startPromise ??= this.host.start()
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
    this.closed = true
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

  private activateRoutes(authority: BrowserClientHostLeaseAuthority): void {
    if (this.closed || this.routes) {
      throw new Error('browser_client_network_route_authority_unavailable')
    }
    this.routes = this.options.createRoutes(authority)
  }

  private requireRoutes(): ComposedNetworkRoutes {
    if (!this.routes || this.closed) {
      throw new Error('browser_client_network_route_authority_unavailable')
    }
    return this.routes
  }

  private async closeComposition(error: Error): Promise<boolean> {
    const failures: unknown[] = []
    let handlersSettled = false
    try {
      handlersSettled = await this.host.close(error)
    } catch (hostError) {
      failures.push(hostError)
    }
    if (handlersSettled) {
      try {
        await this.executor.close()
      } catch (executorError) {
        failures.push(executorError)
      }
    } else {
      this.deferredExecutorClose = this.host.whenHandlersSettled().then(() => this.executor.close())
      void this.deferredExecutorClose.catch((cleanupError) =>
        this.reportCleanupError(asError(cleanupError))
      )
    }
    try {
      await this.routes?.close(error)
    } catch (routeError) {
      failures.push(routeError)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client host composition cleanup failed')
    }
    return handlersSettled
  }

  private handleHostError(error: Error): void {
    void this.close(error).catch((closeError) => this.reportError(asError(closeError)))
    this.reportError(error)
  }

  private reportError(error: Error): void {
    if (this.errorReported) {
      return
    }
    this.errorReported = true
    try {
      this.options.onError?.(error)
    } catch {
      // Reporting cannot retain a failed browser host composition.
    }
  }

  private reportCleanupError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {
      // Reporting cannot release ambiguous cleanup state.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
