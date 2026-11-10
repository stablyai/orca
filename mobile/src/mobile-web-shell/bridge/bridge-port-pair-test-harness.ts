import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { createFakeRpcClient, type FakeRpcClient } from '../bridge-host-test-fakes'
import { createBridgeHost, type BridgeHostDiagnostic } from '../bridge-host'
import type { BridgeNavigateBackOutcome } from '../bridge-host-contract'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge-caps'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import { readBridgeClientMessage, readBridgeHostMessage } from './bridge-envelope'
import type { BridgeErrorCapture } from './bridge-error-capture'
import {
  createBridgeRpcClient,
  type BridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from './bridge-rpc-client'

// Use one FIFO per direction so subscribe/request ordering preserves recorder ordinals; deliver on microtasks so zero-time golden drains advance no virtual milliseconds.
// Accept the recorder’s scripted client as well as the ordinary fake client.
import type { BridgePortPair, BridgePortPairOptions } from './bridge-port-pair-contract'
export type {
  BridgePortPair,
  BridgePortPairOptions,
  BridgeQueuedObservation,
  BridgeFixturePost,
  BridgePortObservation
} from './bridge-port-pair-contract'
import { createLane, readAll, defaultVerbAnswer, neutralObservation } from './bridge-port-lane'

export const PORT_PAIR_CLIENT_IDENTITY = 'device-token-a'

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
  const terminalKeyRailClaims: boolean[] = []
  let pageReadies = 0
  let pagePaints = 0
  const routeParamClears: { param: string; value: string }[] = []
  const routeRefusals: string[] = []
  let receiveOnPage: ((json: string) => void) | null = null
  let releasePagePort: (() => void) | undefined

  const rewrite = options.rewriteToPage ?? ((json: string) => json)
  const deliverToPage = (json: string) => {
    const delivered = rewrite(json)
    options.observation?.receivePage(json, delivered)
    receiveOnPage?.(delivered)
  }
  const toPage = createLane(
    (json) => {
      if (!options.holdToPage?.(json)) {
        deliverToPage(json)
      }
    },
    (json) => options.observation?.capturePost(json, 'page') ?? neutralObservation()
  )
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
    ...(options.foldDivision === undefined ? {} : { foldDivision: options.foldDivision }),
    ...(options.terminalKeyRail === undefined ? {} : { terminalKeyRail: options.terminalKeyRail }),
    readClientIdentity: () =>
      options.clientIdentity === undefined ? PORT_PAIR_CLIENT_IDENTITY : options.clientIdentity,
    pageRoutes: options.pageRoutes ?? ['/h/[hostId]'],
    routeGrants: options.routeGrants ?? MOBILE_WEB_SHELL_GRANTS,
    ...(options.ownsHostArea === undefined ? {} : { ownsHostArea: options.ownsHostArea }),
    sessionEstablished: options.sessionEstablished ?? false,
    onNavigate: (href) => navigations.push(href),
    onExternalLink: (url) => externalLinks.push(url),
    onHaptic: (kind) => haptics.push(kind),
    // No device exists in this pair; native replies/refusals stay on the shell without desktop forwarding.
    serveNativeVerb: (verb, params) =>
      options.serveNativeVerb?.(verb, params) ??
      Promise.resolve(defaultVerbAnswer(verb, params, options.storage ?? {})),
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
    onPageLocation: () => {},
    onTerminalKeyRailClaim: (claimed) => terminalKeyRailClaims.push(claimed),
    onRouteParamClear: (param, value) => routeParamClears.push({ param, value }),
    onRouteRefused: (issue) => routeRefusals.push(issue),
    onDiagnostic: (diagnostic) => hostDiagnostics.push(diagnostic)
  })
  const toShell = createLane(
    (json) => {
      host.receive(json)
    },
    (json) => options.observation?.capturePost(json, 'shell') ?? neutralObservation()
  )
  let actualClient: BridgeRpcClient
  try {
    actualClient = createBridgeRpcClient({
      send: (json) => {
        toShell.push(json)
      },
      onMessage: (handler) => {
        receiveOnPage = handler
        releasePagePort = () => {
          receiveOnPage = null
        }
        return releasePagePort
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })
  } catch (error) {
    const errors = [error]
    for (const rollback of [() => host.dispose(), () => releasePagePort?.()]) {
      try {
        rollback()
      } catch (rollbackError) {
        errors.push(rollbackError)
      }
    }
    if (errors.length === 1) {
      throw error
    }
    throw new AggregateError(errors, 'Port pair setup and rollback failed')
  }
  const client: BridgeRpcClient = options.observation?.invokePage
    ? {
        ...actualClient,
        sendRequest: (...args) =>
          options.observation!.invokePage!(args, () => actualClient.sendRequest(...args))
      }
    : actualClient
  return {
    client,
    host,
    rpc,
    toShell: toShell.sent,
    toShellPosts: toShell.posts,
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
    terminalKeyRailClaims,
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
    receiveFromShell: (json) => toPage.push(json),
    deliverToPage,
    readToShell: () => readAll(toShell.sent, readBridgeClientMessage),
    readToPage: () => readAll(toPage.sent, readBridgeHostMessage)
  }
}

// Send desktop calls until one is refused, by whichever side refuses first; resolves to how many were admitted.
export async function fillFreeDesktopSlots(pair: BridgePortPair): Promise<number> {
  for (let admitted = 0; admitted <= BRIDGE_MAX_PENDING_REQUESTS; admitted += 1) {
    let refused = false
    const pending = pair.client.sendRequest('worktree.list').catch(() => {
      refused = true
    })
    await pair.flush()
    if (refused) {
      await pending
      return admitted
    }
  }
  return BRIDGE_MAX_PENDING_REQUESTS + 1
}

export function createFakeBridgePortPair(
  options: Omit<BridgePortPairOptions<FakeRpcClient>, 'rpc'> & { rpc?: FakeRpcClient } = {}
): BridgePortPair<FakeRpcClient> {
  return createBridgePortPair({ ...options, rpc: options.rpc ?? createFakeRpcClient() })
}

// Attempt each already-owned teardown phase even when an earlier original close throws.
export async function disposeBridgePortPair(
  pair: Pick<BridgePortPair<RpcClient>, 'client' | 'host' | 'flush'>
): Promise<void> {
  const errors: unknown[] = []
  // Async wrappers turn a synchronous close/dispose throw into a rejection the same catch records.
  for (const cleanup of [
    async () => pair.client.close(),
    async () => pair.host.dispose(),
    () => pair.flush()
  ]) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Bridge pair teardown failed')
  }
}
