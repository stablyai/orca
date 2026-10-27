// Parse fake-client host frames with the page’s real reader so both halves meet in these tests.
import { afterEach } from 'vitest'
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

const hosts = new Set<BridgeHost>()
afterEach(() => {
  for (const host of hosts) {
    host.dispose()
  }
  hosts.clear()
})

export const ID = bridgeId(1)
export const OTHER = bridgeId(2)

export type Harness = {
  host: BridgeHost
  client: FakeRpcClient
  posted: string[]
  diagnostics: BridgeHostDiagnostic[]
  droppedBinaryFrames: number[]
  navigations: string[]
  externalLinks: string[]
  haptics: BridgeHapticsKind[]
  nativeCalls: { verb: BridgeNativeVerb; params: unknown }[]
  clipboardWrites: string[]
  backPops: BridgeNavigateBackOutcome[]
  storageWrites: { key: string; value: string | null }[]
  pageReadyCount: () => number
  pagePaintCount: () => number
  backClaims: boolean[]
  /** Every clear the page asked for, in order. */
  routeParamClears: () => readonly { param: string; value: string }[]
  routeRefusals: string[]
  pageFaults: BridgeErrorCapture[]
  frames: () => BridgeHostMessage[]
  last: () => BridgeHostMessage
}

export const HARNESS_CLIENT_IDENTITY = 'device-token-a'
export const ROUTE = { pathname: '/h/host-a' }
export const PAGE_ROUTES = ['/h/[hostId]']
export const PAGE_ROUTE_GRANTS = [
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] }
]
export const HOST = { id: 'host-a', name: 'Host A', endpoint: 'ws://host-a', lastConnected: 5 }

export function harness(
  options: {
    client?: FakeRpcClient
    post?: (json: string) => Promise<void>
    route?: BridgeInitRoute
    onNavigate?: (href: string, replace: boolean) => void
    onNavigateBack?: () => BridgeNavigateBackOutcome
    storage?: Readonly<Record<string, string>>
    readStorage?: () => PageStorageForInit
    onPageFault?: (error: BridgeErrorCapture) => void
    /** What the mounted route declared; everything this shell implements unless a case narrows it. */
    routeGrants?: readonly string[]
    pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
    sessionEstablished?: boolean
    clientIdentity?: string | null
    // Off by default for pre-ready refusal cases; real pages ask ready before opening requests.
    ready?: boolean
    clipboardText?: string
    serveNativeVerb?: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
    terminalTimers?: TerminalBacklogTimers
    sessionBack?: BridgeSessionBack
  } = {}
): Harness {
  const client = options.client ?? createFakeRpcClient()
  const posted: string[] = []
  const diagnostics: BridgeHostDiagnostic[] = []
  const navigations: string[] = []
  const externalLinks: string[] = []
  const haptics: BridgeHapticsKind[] = []
  const nativeCalls: { verb: BridgeNativeVerb; params: unknown }[] = []
  const clipboardWrites: string[] = []
  const backPops: BridgeNavigateBackOutcome[] = []
  const storageWrites: { key: string; value: string | null }[] = []
  const backClaims: boolean[] = []
  let pageReadies = 0
  let pagePaints = 0
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
    onPageReady: () => {
      pageReadies += 1
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
      nativeCalls.push({ verb, params })
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
  hosts.add(host)
  if (options.ready === true) {
    host.receive(clientFrame({ type: 'ready' }))
  }
  // Use the page’s reader: a host frame it refuses must fail the harness, not pass as a hand-built expected shape.
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
    nativeCalls,
    clipboardWrites,
    backPops,
    storageWrites,
    pageReadyCount: () => pageReadies,
    pagePaintCount: () => pagePaints,
    backClaims,
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
