/** One bridge host wired to a fake client, read back through the page's own reader.
 *  Shared because the suites that exercise it are split by concern, not by fixture. */
import {
  bridgeId,
  clientFrame,
  createFakeRpcClient,
  type FakeRpcClient
} from './bridge-host-test-fakes'
import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from './bridge-host'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'
import {
  readBridgeHostMessage,
  type BridgeHostMessage,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'

export const ID = bridgeId(1)
export const OTHER = bridgeId(2)

export type Harness = {
  host: BridgeHost
  client: FakeRpcClient
  posted: string[]
  diagnostics: BridgeHostDiagnostic[]
  navigations: string[]
  /** One entry per `navigate-back` the host answered, in order, with what the shell did. */
  backPops: BridgeNavigateBackOutcome[]
  storageWrites: { key: string; value: string | null }[]
  pageReadyCount: () => number
  routeRefusals: string[]
  pageFaults: BridgeErrorCapture[]
  frames: () => BridgeHostMessage[]
  last: () => BridgeHostMessage
}

export const ROUTE = { pathname: '/h/host-a' }
export const PAGE_ROUTES = ['/h/[hostId]']
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
    readStorage?: () => Readonly<Record<string, string>>
    onPageFault?: (error: BridgeErrorCapture) => void
  } = {}
): Harness {
  const client = options.client ?? createFakeRpcClient()
  const posted: string[] = []
  const diagnostics: BridgeHostDiagnostic[] = []
  const navigations: string[] = []
  const backPops: BridgeNavigateBackOutcome[] = []
  const storageWrites: { key: string; value: string | null }[] = []
  let pageReadies = 0
  const routeRefusals: string[] = []
  const pageFaults: BridgeErrorCapture[] = []
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
    host: HOST,
    readStorage: options.readStorage ?? (() => options.storage ?? {}),
    onStorageWrite: (key, value) => storageWrites.push({ key, value }),
    onPageReady: () => {
      pageReadies += 1
    },
    onRouteRefused: (issue) => routeRefusals.push(issue),
    onNavigate: options.onNavigate ?? ((href) => navigations.push(href)),
    onNavigateBack: () => {
      const outcome = options.onNavigateBack?.() ?? 'popped'
      backPops.push(outcome)
      return outcome
    },
    onPageFault: (error) => {
      pageFaults.push(error)
      options.onPageFault?.(error)
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
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
    navigations,
    backPops,
    storageWrites,
    pageReadyCount: () => pageReadies,
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
