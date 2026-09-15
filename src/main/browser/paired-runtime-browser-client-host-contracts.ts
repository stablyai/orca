import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { BrowserClientHostAuthorityReplacementWait } from './browser-client-host-authority-replacement-wait'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import type { BrowserClientPageAuthorityIdentity as BrowserClientHostAuthorityTransitionInput } from './browser-client-page-command-executor-dependencies'
import type { ComposedBrowserClientNetworkRoutes } from './paired-runtime-browser-client-host-route-sets'
export type ComposedPageExecutor = {
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

export type ComposedClientHost = {
  start(): Promise<BrowserClientHostLeaseAuthority>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  forgetPage(browserPageId: string, pageHostGeneration: number): boolean
  whenHandlersSettled(): Promise<void>
  refreshPageInventory(): Promise<void>
  close(error?: Error): Promise<boolean>
}

export type ClientHostCallbacks = {
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

export type PairedRuntimeBrowserClientHostCompositionOptions<
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
