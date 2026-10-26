import type { RpcClient } from '../../transport/rpc-client'
import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from '../bridge-host'
import type { BridgeNavigateBackOutcome } from '../bridge-host-contract'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import type { BridgeNativeVerb } from './bridge-native-verbs'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import { createFakeRpcClient, type FakeRpcClient } from '../bridge-host-test-fakes'
import {
  readBridgeClientMessage,
  readBridgeHostMessage,
  type BridgeClientMessage,
  type BridgeHostMessage,
  type BridgeInitRoute
} from './bridge-envelope'
import type { BridgeErrorCapture } from './bridge-error-capture'
import type { BridgeSafeAreaInsets } from './bridge-safe-area-insets'
import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from './bridge-rpc-client'

// Use one FIFO per direction so subscribe/request ordering preserves recorder ordinals; deliver on microtasks so zero-time golden drains advance no virtual milliseconds.
// Accept the recorder’s scripted client as well as the ordinary fake client.
export type BridgePortPair<TRpc extends RpcClient = FakeRpcClient> = {
  client: BridgeRpcClient
  host: BridgeHost
  rpc: TRpc
  toShell: string[]
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
}

type Lane = {
  sent: string[]
  push: (json: string) => void
  drainNow: () => number
  readonly depth: number
}

export const PORT_PAIR_CLIENT_IDENTITY = 'device-token-a'

function createLane(deliver: (json: string) => void): Lane {
  const sent: string[] = []
  const queue: string[] = []
  let scheduled = false
  function drain(): void {
    scheduled = false
    const next = queue.shift()
    if (next === undefined) {
      return
    }
    deliver(next)
    schedule()
  }
  function schedule(): void {
    if (scheduled || queue.length === 0) {
      return
    }
    scheduled = true
    void Promise.resolve().then(drain)
  }
  return {
    sent,
    push(json: string): void {
      sent.push(json)
      queue.push(json)
      schedule()
    },
    drainNow(): number {
      let moved = 0
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        deliver(next)
        moved += 1
      }
      return moved
    },
    get depth(): number {
      return queue.length
    }
  }
}

function readAll<TMessage>(
  frames: readonly string[],
  read: (json: string) => { ok: true; message: TMessage } | { ok: false; refusal: string }
): TMessage[] {
  return frames.map((json) => {
    const parsed = read(json)
    if (!parsed.ok) {
      throw new Error(`the other side would have refused this frame: ${parsed.refusal}`)
    }
    return parsed.message
  })
}

// Keep a valid default reply per verb table row so unconfigured native calls do not fail as malformed shell results.
function defaultVerbAnswer(verb: BridgeNativeVerb): unknown {
  switch (verb) {
    case 'native.clipboard.write':
      return { written: true }
    case 'native.clipboard.read':
      return { value: 'pasteboard' }
    case 'native.media.pick':
      return { items: [] }
    case 'native.media.read':
      return { base64: '', eof: true }
    case 'native.media.release':
      return { released: false }
    case 'native.media.name':
      return { name: null }
    case 'native.audio.start':
      return { started: true, sampleRate: 16_000, permission: 'granted' }
    case 'native.audio.read':
      return { base64: '', droppedBytes: 0, recording: true, interruption: null }
    case 'native.audio.stop':
      return { stopped: true, base64: '', droppedBytes: 0 }
  }
}

export function createBridgePortPair<TRpc extends RpcClient>(
  options: BridgePortPairOptions<TRpc>
): BridgePortPair<TRpc> {
  const rpc = options.rpc
  const diagnostics: BridgeRpcClientDiagnostic[] = []
  const hostDiagnostics: BridgeHostDiagnostic[] = []
  const navigations: string[] = []
  const externalLinks: string[] = []
  const haptics: BridgeHapticsKind[] = []
  const backPops: BridgeNavigateBackOutcome[] = []
  const storageWrites: { key: string; value: string | null }[] = []
  const pageFaults: BridgeErrorCapture[] = []
  const backClaims: boolean[] = []
  let pageReadies = 0
  let pagePaints = 0
  const routeParamClears: { param: string; value: string }[] = []
  const routeRefusals: string[] = []
  let receiveOnPage: ((json: string) => void) | null = null

  const rewrite = options.rewriteToPage ?? ((json: string) => json)
  const toPage = createLane((json) => {
    receiveOnPage?.(rewrite(json))
  })
  const host = createBridgeHost({
    client: rpc,
    post: (json) => {
      toPage.push(json)
      return Promise.resolve()
    },
    buildId: options.buildId ?? 'build-a',
    sessionId: options.sessionId ?? 'session-a',
    route: options.route ?? { pathname: '/h/host-a' },
    ...(options.safeAreaInsets === undefined ? {} : { safeAreaInsets: options.safeAreaInsets }),
    ...(options.keyboardInset === undefined ? {} : { keyboardInset: options.keyboardInset }),
    readClientIdentity: () =>
      options.clientIdentity === undefined ? PORT_PAIR_CLIENT_IDENTITY : options.clientIdentity,
    pageRoutes: options.pageRoutes ?? ['/h/[hostId]'],
    routeGrants: options.routeGrants ?? MOBILE_WEB_SHELL_GRANTS,
    ...(options.ownsHostArea === undefined ? {} : { ownsHostArea: options.ownsHostArea }),
    sessionEstablished: options.sessionEstablished ?? false,
    onNavigate: (href) => navigations.push(href),
    onExternalLink: (url) => externalLinks.push(url),
    onHaptic: (kind) => haptics.push(kind),
    // No device exists in this pair; answer each native verb with its declared shape and prove it was not forwarded.
    serveNativeVerb: (verb, params) =>
      options.serveNativeVerb?.(verb, params) ?? Promise.resolve(defaultVerbAnswer(verb)),
    onNavigateBack: () => {
      backPops.push('popped')
      return 'popped'
    },
    host: { id: 'host-a', name: 'Host A', endpoint: 'ws://host-a', lastConnected: 0 },
    readStorage: () => ({
      storage: options.storage ?? {},
      storageOversize: options.storageOversize ?? []
    }),
    onStorageWrite: (key, value) => {
      storageWrites.push({ key, value })
      options.onStorageWrite?.(key, value)
    },
    onPageFault: (error) => pageFaults.push(error),
    onPageReady: () => {
      pageReadies += 1
    },
    onPagePainted: () => {
      pagePaints += 1
    },
    onPageBackClaim: (claimed) => backClaims.push(claimed),
    onRouteParamClear: (param, value) => routeParamClears.push({ param, value }),
    onRouteRefused: (issue) => routeRefusals.push(issue),
    onDiagnostic: (diagnostic) => hostDiagnostics.push(diagnostic)
  })
  const toShell = createLane((json) => {
    host.receive(json)
  })
  const client = createBridgeRpcClient({
    send: (json) => {
      toShell.push(json)
    },
    onMessage: (handler) => {
      receiveOnPage = handler
      return () => {
        receiveOnPage = null
      }
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  return {
    client,
    host,
    rpc,
    toShell: toShell.sent,
    toPage: toPage.sent,
    diagnostics,
    hostDiagnostics,
    navigations,
    externalLinks,
    haptics,
    backPops,
    storageWrites,
    pageFaults,
    pageReadyCount: () => pageReadies,
    pagePaintCount: () => pagePaints,
    backClaims,
    routeParamClears: () => routeParamClears,
    routeRefusals,
    async flush(): Promise<void> {
      for (let round = 0; round < 64; round += 1) {
        const moved = toShell.sent.length + toPage.sent.length
        for (let turn = 0; turn < 8; turn += 1) {
          await Promise.resolve()
        }
        const quiet =
          toShell.depth === 0 &&
          toPage.depth === 0 &&
          moved === toShell.sent.length + toPage.sent.length
        if (quiet) {
          return
        }
      }
      throw new Error('the port pair never went quiet')
    },
    drainNow: () => toShell.drainNow() + toPage.drainNow(),
    readToShell: () => readAll(toShell.sent, readBridgeClientMessage),
    readToPage: () => readAll(toPage.sent, readBridgeHostMessage)
  }
}

export function createFakeBridgePortPair(
  options: Omit<BridgePortPairOptions<FakeRpcClient>, 'rpc'> & { rpc?: FakeRpcClient } = {}
): BridgePortPair<FakeRpcClient> {
  return createBridgePortPair({ ...options, rpc: options.rpc ?? createFakeRpcClient() })
}
