import type { RpcClient } from '../../transport/rpc-client'
import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from '../bridge-host'
import type { BridgeNavigateBackOutcome } from '../bridge-host-contract'
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
import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from './bridge-rpc-client'

/**
 * The page and the shell wired to each other through the weakest transport that is still a
 * transport, so a test of either one is a test of the pair.
 *
 * Two properties are the whole point. One FIFO per direction, because the payloads a shell client
 * publishes are published in delivery order, so a lane that let a `subscribe` pass a `sendRequest`
 * would move the recorder's shared ordinal and manufacture the reorder `write-ordinal.ts` exists to
 * catch. And delivery on a microtask, the weakest async the golden runner's zero-time drains flush
 * and the only one that moves no virtual millisecond.
 *
 * The shell client is a type parameter because the golden recorder puts its own scripted client
 * behind this pair; `createFakeBridgePortPair` is the shape every other test wants.
 */
export type BridgePortPair<TRpc extends RpcClient = FakeRpcClient> = {
  client: BridgeRpcClient
  host: BridgeHost
  rpc: TRpc
  /** Everything each side posted, in the order it was posted, raw. */
  toShell: string[]
  toPage: string[]
  diagnostics: BridgeRpcClientDiagnostic[]
  hostDiagnostics: BridgeHostDiagnostic[]
  /** Every screen the page asked the shell to open, in order. */
  navigations: string[]
  /** Every URL the page asked the shell to open outside the app, in order. */
  externalLinks: string[]
  /** One entry per stack pop the page asked for, with what the shell did about it. */
  backPops: BridgeNavigateBackOutcome[]
  /** Every allowlisted key the page wrote through the shell, in order. */
  storageWrites: { key: string; value: string | null }[]
  /** Every fault the page reported, in order, as the shell received it. */
  pageFaults: BridgeErrorCapture[]
  /** How many times the page asked for a session; it re-asks on a backoff until one lands. */
  readonly pageReadyCount: () => number
  /** Why the host refused to open a session at all, if it did. */
  readonly routeRefusals: string[]
  /** Runs both lanes until a full round moves nothing. */
  flush: () => Promise<void>
  /**
   * Delivers what is queued right now, in place, and returns how many frames moved.
   *
   * For the one exchange a caller cannot await: a page refuses every member until `init` lands, and
   * a recorder that mounted a screen before then would record a different first render. Nothing
   * else may use it — delivering in place is what the lanes exist not to do.
   */
  drainNow: () => number
  /** Read back through the reader on the receiving side, so a frame this returns is one that lands. */
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
  /**
   * Rewrites each frame on its way to the page, for asking the page a counterfactual it cannot be
   * asked any other way: would this run have gone differently had the shell sent one more field?
   * The golden recorder's bridged replay uses it to separate what a narrow reader costs from what
   * the payload itself does. Nothing in the product rewrites a frame in flight.
   */
  rewriteToPage?: (json: string) => string
  /** What the mounted route declared; everything this shell implements unless a case narrows it. */
  routeGrants?: readonly string[]
  /** Stands for a host rebuilt under a page whose session already handshook. */
  sessionEstablished?: boolean
  /** Replaces the verb handler, for the arms where the shell refuses rather than answers. */
  serveNativeVerb?: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
}

type Lane = {
  sent: string[]
  push: (json: string) => void
  drainNow: () => number
  readonly depth: number
}

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

/** One answer per row of the verb table. Adding a verb without a row here is a refusal a case
 *  would have to read as a result shape the shell does not declare. */
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
  const backPops: BridgeNavigateBackOutcome[] = []
  const storageWrites: { key: string; value: string | null }[] = []
  const pageFaults: BridgeErrorCapture[] = []
  let pageReadies = 0
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
    pageRoutes: options.pageRoutes ?? ['/h/[hostId]'],
    routeGrants: options.routeGrants ?? MOBILE_WEB_SHELL_GRANTS,
    sessionEstablished: options.sessionEstablished ?? false,
    onNavigate: (href) => navigations.push(href),
    onExternalLink: (url) => externalLinks.push(url),
    // The pair has no device: what a test reads here is that the host answered without forwarding.
    // Each verb gets a shape its own row declares, so a case that calls one it did not configure
    // reads an answer rather than `native_verb_result`, which is a shell bug's code.
    serveNativeVerb: (verb, params) =>
      options.serveNativeVerb?.(verb, params) ?? Promise.resolve(defaultVerbAnswer(verb)),
    onNavigateBack: () => {
      // A pair has no stack, so the pop always lands: what a test reads here is that the host acted.
      backPops.push('popped')
      return 'popped'
    },
    host: { id: 'host-a', name: 'Host A', endpoint: 'ws://host-a', lastConnected: 0 },
    readStorage: () => options.storage ?? {},
    onStorageWrite: (key, value) => storageWrites.push({ key, value }),
    onPageFault: (error) => pageFaults.push(error),
    onPageReady: () => {
      pageReadies += 1
    },
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
    backPops,
    storageWrites,
    pageFaults,
    pageReadyCount: () => pageReadies,
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

/** The pair every test that is not the golden recorder wants: a shell client that records calls. */
export function createFakeBridgePortPair(
  options: Omit<BridgePortPairOptions<FakeRpcClient>, 'rpc'> & { rpc?: FakeRpcClient } = {}
): BridgePortPair<FakeRpcClient> {
  return createBridgePortPair({ ...options, rpc: options.rpc ?? createFakeRpcClient() })
}
