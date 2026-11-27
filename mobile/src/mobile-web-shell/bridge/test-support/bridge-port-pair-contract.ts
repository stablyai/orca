import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type {
  BridgeHost,
  BridgeHostDiagnostic,
  BridgeNavigateBackOutcome
} from '../../host-bridge/bridge-host-contract'
import type { BridgeHapticsKind } from '../native-capabilities/bridge-haptics-notify'
import type { BridgeNativeVerb } from '../native-capabilities/bridge-native-verbs'
import type { FakeRpcClient } from '../../test-support/bridge-host-test-fakes'
import type { BridgeClientMessage, BridgeHostMessage } from '../protocol/bridge-envelope'
import type { BridgeInitRoute } from '../protocol/bridge-init-route'
import type { BridgeErrorCapture } from '../protocol/bridge-error-capture'
import type { BridgeSafeAreaInsets } from '../page-geometry/bridge-safe-area-insets'
import type { BridgeFoldDivision } from '../page-geometry/bridge-fold-division'
import type { BridgeTerminalKeyRail } from '../native-capabilities/bridge-terminal-key'
import type { BridgeRpcClient } from '../client-state/bridge-rpc-client-contract'
import type { BridgeRpcClientDiagnostic } from '../client-state/bridge-client-diagnostics'

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
  readonly terminalKeyRailClaims: boolean[]
  readonly routeParamClears: () => readonly { param: string; value: string }[]
  readonly routeRefusals: string[]
  flush: () => Promise<void>
  // Flush init synchronously only for first-render recording; every other exchange must retain asynchronous lane delivery.
  drainNow: () => number
  receiveFromShell: (json: string) => void
  deliverToPage: (json: string) => void
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
  holdToPage?: (json: string) => boolean
  rewriteToPage?: (json: string) => string
  routeGrants?: readonly string[]
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
  sessionEstablished?: boolean
  clientIdentity?: string | null
  serveNativeVerb?: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  safeAreaInsets?: BridgeSafeAreaInsets
  keyboardInset?: number
  foldDivision?: BridgeFoldDivision | null
  terminalKeyRail?: BridgeTerminalKeyRail
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
