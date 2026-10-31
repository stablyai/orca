import type { RpcClient } from '../../transport/rpc-client'
import type { BridgeHost, BridgeHostDiagnostic } from '../bridge-host'
import type { BridgeNavigateBackOutcome } from '../bridge-host-contract'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import type { BridgeNativeVerb } from './bridge-native-verbs'
import type { FakeRpcClient } from '../bridge-host-test-fakes'
import type { BridgeClientMessage, BridgeHostMessage, BridgeInitRoute } from './bridge-envelope'
import type { BridgeErrorCapture } from './bridge-error-capture'
import type { BridgeSafeAreaInsets } from './bridge-safe-area-insets'
import type { BridgeRpcClient, BridgeRpcClientDiagnostic } from './bridge-rpc-client'

export type BridgePortPair<TRpc extends RpcClient = FakeRpcClient> = {
  client: BridgeRpcClient
  host: BridgeHost
  rpc: TRpc
  toShell: string[]
  toShellPosts: readonly BridgeFixturePost[]
  toPage: string[]
  diagnostics: BridgeRpcClientDiagnostic[]
  hostDiagnostics: BridgeHostDiagnostic[]
  navigations: string[]
  externalLinks: string[]
  haptics: BridgeHapticsKind[]
  backPops: BridgeNavigateBackOutcome[]
  storageWrites: { key: string; value: string | null }[]
  pageFaults: BridgeErrorCapture[]
  readonly pageReadyCount: () => number
  readonly pagePaintCount: () => number
  readonly backClaims: boolean[]
  readonly routeParamClears: () => readonly { param: string; value: string }[]
  readonly routeRefusals: string[]
  flush: () => Promise<void>
  // Flush init synchronously only for first-render recording; every other exchange must retain asynchronous lane delivery.
  drainNow: () => number
  receiveFromShell: (json: string) => void
  readToShell: () => BridgeClientMessage[]
  readToPage: () => BridgeHostMessage[]
}

export type BridgePortPairOptions<TRpc extends RpcClient> = {
  rpc: TRpc
  sessionId?: string
  buildId?: string
  route?: BridgeInitRoute
  pageRoutes?: readonly string[]
  storage?: Readonly<Record<string, string>>
  storageOversize?: readonly string[]
  // Test-only frame rewrite lets golden replay isolate narrower-reader behavior from payload changes; product transport never rewrites in-flight frames.
  rewriteToPage?: (json: string) => string
  routeGrants?: readonly string[]
  sessionEstablished?: boolean
  clientIdentity?: string | null
  serveNativeVerb?: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  safeAreaInsets?: BridgeSafeAreaInsets
  keyboardInset?: number
  ownsHostArea?: boolean
  onStorageWrite?: (key: string, value: string | null) => void
  observation?: BridgePortObservation
}

export type BridgeQueuedObservation = {
  enqueued: () => void
  runDelivery: (receive: () => void) => void
  captureReceipt?: (json: string) => BridgeQueuedObservation
}

export type BridgeFixturePost = { readonly json: string; receiveAgain: (json: string) => void }

// Test evidence travels beside each item; no observer value enters the protocol.
export type BridgePortObservation = {
  invokePage?: <T>(args: Parameters<RpcClient['sendRequest']>, invoke: () => T) => T
  capturePost: (json: string, direction: 'shell' | 'page') => BridgeQueuedObservation
  receivePage: (original: string, delivered: string) => void
}
