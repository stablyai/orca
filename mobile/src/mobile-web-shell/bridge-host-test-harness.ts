/** One bridge host wired to a fake client, read back through the page's own reader.
 *  Shared because the suites that exercise it are split by concern, not by fixture. */
import {
  bridgeId,
  clientFrame,
  createFakeRpcClient,
  type FakeRpcClient
} from './bridge-host-test-fakes'
import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from './bridge-host'
import type { BridgeSessionBack } from './bridge-host-back'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'
import {
  BRIDGE_NATIVE_VERBS,
  clipboardWriteParamsSchema,
  type BridgeNativeVerb
} from './bridge/bridge-native-verbs'
import {
  readBridgeHostMessage,
  type BridgeHostMessage,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import type { TerminalBacklogTimers } from './bridge-terminal-output-backlog'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { PageStorageForInit } from './page-storage-keys'

export const ID = bridgeId(1)
export const OTHER = bridgeId(2)

export type Harness = {
  host: BridgeHost
  client: FakeRpcClient
  posted: string[]
  diagnostics: BridgeHostDiagnostic[]
  /** The running total after each dropped screencast frame, which is what the dev facts render. */
  droppedBinaryFrames: number[]
  navigations: string[]
  /** Every URL the page asked the shell to open outside the app, in order. */
  externalLinks: string[]
  /** Every haptic the page asked the shell to play, in order. */
  haptics: BridgeHapticsKind[]
  /** Every text the page wrote to the pasteboard through a native verb, in order. */
  clipboardWrites: string[]
  /** One entry per `navigate-back` the host answered, in order, with what the shell did. */
  backPops: BridgeNavigateBackOutcome[]
  storageWrites: { key: string; value: string | null }[]
  pageReadyCount: () => number
  pagePaintCount: () => number
  /** Every claim the host reported, in order, including the false it sends when a document ends. */
  backClaims: boolean[]
  /** What each answered `ready` declared it reports, in order. */
  pageReports: () => readonly (readonly string[])[]
  /** One entry per `ready` answered, saying whether its `init` reached the page. Filled as each
   *  post settles, so a case reads it after awaiting the turn the post resolves on. */
  /** Every clear the page asked for, in order. */
  routeParamClears: () => readonly { param: string; value: string }[]
  routeRefusals: string[]
  pageFaults: BridgeErrorCapture[]
  frames: () => BridgeHostMessage[]
  last: () => BridgeHostMessage
}

/** This device's identity to the host, as the shell reads it off the native client. */
export const HARNESS_CLIENT_IDENTITY = 'device-token-a'
export const ROUTE = { pathname: '/h/host-a' }
export const PAGE_ROUTES = ['/h/[hostId]']
/** What those patterns declared, as the manifest would carry it, `haptics` included: it is on every
 *  real entry, so a pair without it is a shape the host never receives. */
export const PAGE_ROUTE_GRANTS = [
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] }
]
export const HOST = { id: 'host-a', name: 'Host A', endpoint: 'ws://host-a', lastConnected: 5 }

export function harness(
  options: {
    client?: FakeRpcClient
    post?: (json: string) => Promise<void>
    route?: BridgeInitRoute
    onNavigate?: (href: string) => void
    onNavigateBack?: () => BridgeNavigateBackOutcome
    storage?: Readonly<Record<string, string>>
    /** For the suites that need the map to change between two `init` answers. */
    readStorage?: () => PageStorageForInit
    onPageFault?: (error: BridgeErrorCapture) => void
    /**
     * Whether to answer a `ready` before the case runs, which is what a real page does first: the
     * host serves no request until it has issued an `init`. Off by default so a case about the
     * pre-ready refusals can still be written.
     */
    /** What the mounted route declared; everything this shell implements unless a case narrows it. */
    routeGrants?: readonly string[]
    /** The manifest pairs this shell would send; a case may hand it a malformed one. */
    pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
    /** Stands for a host rebuilt under a page whose session already handshook. */
    sessionEstablished?: boolean
    /** This device's identity to the host; `null` stands for one the shell cannot read yet. */
    clientIdentity?: string | null
    ready?: boolean
    /** What the pasteboard answers a read with. */
    clipboardText?: string
    /** Replaces the whole verb handler, for the arm where a device call fails. */
    serveNativeVerb?: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
    /** Drives the held-stream silence clock, so a case fires it instead of waiting on it. */
    terminalTimers?: TerminalBacklogTimers
    /** Stands for a host rebuilt over a session that already declared and claimed the Back key. */
    sessionBack?: BridgeSessionBack
  } = {}
): Harness {
  const client = options.client ?? createFakeRpcClient()
  const posted: string[] = []
  const diagnostics: BridgeHostDiagnostic[] = []
  const navigations: string[] = []
  const externalLinks: string[] = []
  const haptics: BridgeHapticsKind[] = []
  const clipboardWrites: string[] = []
  const backPops: BridgeNavigateBackOutcome[] = []
  const storageWrites: { key: string; value: string | null }[] = []
  const backClaims: boolean[] = []
  let pageReadies = 0
  let pagePaints = 0
  /** What each answered `ready` declared it reports, in order. */
  const pageReports: (readonly string[])[] = []
  /** One entry per `ready` answered, saying whether an `init` actually went out for it. */
  const routeParamClears: { param: string; value: string }[] = []
  const routeRefusals: string[] = []
  const pageFaults: BridgeErrorCapture[] = []
  const droppedBinaryFrames: number[] = []
  const host = createBridgeHost({
    client,
    post: (json) => {
      posted.push(json)
      return options.post?.(json) ?? Promise.resolve()
    },
    buildId: 'build-a',
    sessionId: 'session-a',
    route: options.route ?? ROUTE,
    pageRoutes: PAGE_ROUTES,
    pageRouteGrants: options.pageRouteGrants ?? PAGE_ROUTE_GRANTS,
    routeGrants: options.routeGrants ?? MOBILE_WEB_SHELL_GRANTS,
    sessionEstablished: options.sessionEstablished ?? false,
    ...(options.sessionBack === undefined ? {} : { sessionBack: options.sessionBack }),
    readClientIdentity: () =>
      options.clientIdentity === undefined ? HARNESS_CLIENT_IDENTITY : options.clientIdentity,
    host: HOST,
    readStorage:
      options.readStorage ?? (() => ({ storage: options.storage ?? {}, storageOversize: [] })),
    onStorageWrite: (key, value) => storageWrites.push({ key, value }),
    onPageReady: ({ reports }) => {
      pageReadies += 1
      pageReports.push(reports)
    },
    onPageBackClaim: (claimed) => backClaims.push(claimed),
    onPagePainted: () => {
      pagePaints += 1
    },
    onRouteParamClear: (param, value) => routeParamClears.push({ param, value }),
    onRouteRefused: (issue) => routeRefusals.push(issue),
    onNavigate: options.onNavigate ?? ((href) => navigations.push(href)),
    onExternalLink: (url) => externalLinks.push(url),
    onHaptic: (kind) => haptics.push(kind),
    serveNativeVerb: (verb, params) => {
      if (options.serveNativeVerb !== undefined) {
        return options.serveNativeVerb(verb, params)
      }
      const read = BRIDGE_NATIVE_VERBS[verb].params.parse(params)
      if (verb === 'native.clipboard.write') {
        const { value } = clipboardWriteParamsSchema.parse(read)
        clipboardWrites.push(value)
        return Promise.resolve({ written: true })
      }
      return Promise.resolve({ value: options.clipboardText ?? '' })
    },
    onNavigateBack: () => {
      const outcome = options.onNavigateBack?.() ?? 'popped'
      backPops.push(outcome)
      return outcome
    },
    onPageFault: (error) => {
      pageFaults.push(error)
      options.onPageFault?.(error)
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onBinaryFramesDropped: (total) => droppedBinaryFrames.push(total),
    terminalTimers: options.terminalTimers
  })
  if (options.ready === true) {
    host.receive(clientFrame({ type: 'ready' }))
  }
  // Read back through the page's own reader: a frame the host sends that the page would refuse is
  // a frame that never arrives, and this is the only place both halves meet in one test.
  const frames = (): BridgeHostMessage[] =>
    posted.map((json) => {
      const read = readBridgeHostMessage(json)
      if (!read.ok) {
        throw new Error(`the page would refuse this frame: ${read.refusal}`)
      }
      return read.message
    })
  return {
    host,
    client,
    posted,
    diagnostics,
    droppedBinaryFrames,
    navigations,
    externalLinks,
    haptics,
    clipboardWrites,
    backPops,
    storageWrites,
    pageReadyCount: () => pageReadies,
    pagePaintCount: () => pagePaints,
    backClaims,
    pageReports: () => pageReports,
    routeParamClears: () => routeParamClears,
    routeRefusals,
    pageFaults,
    frames,
    last: () => {
      const all = frames()
      const tail = all.at(-1)
      if (tail === undefined) {
        throw new Error('nothing was posted')
      }
      return tail
    }
  }
}

export function subscribeFrame(id: string, method = 'terminal.subscribe'): string {
  return clientFrame({ type: 'subscribe', id, method, params: { terminal: 't' } })
}
