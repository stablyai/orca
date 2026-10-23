import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import type { RpcClient } from '../transport/rpc-client'
import { createBridgeDiagnosticReporter } from './bridge-diagnostic-log'
import { createBridgeHost, type BridgeHost } from './bridge-host'
import type { BridgeSessionBack } from './bridge-host-back'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'
import { bridgeDiagnosticLine } from './shell-bridge-log-lines'
import {
  flushRetainedBridgeFrames,
  parkRetainedBridgeHost,
  postOrQueueRetainedBridgeFrame,
  takeRetainedBridgeHost,
  type RetainedBridgeHostBinding
} from './retained-shell-session-store'
import type { MobileWebShellBridgeArgs } from './use-mobile-web-shell-bridge'
import type { PageHostSnapshot } from './use-page-host-snapshot'

export type MountedBridgeView = { sessionId: string; handle: OrcaMobileWebShellViewHandle }

export class BridgeViewGoneError extends Error {
  constructor() {
    super('the shell view for this session is not mounted')
    this.name = 'BridgeViewGoneError'
  }
}

export function postToMountedBridgeView(
  mounted: MountedBridgeView | null,
  sessionId: string,
  json: string
): Promise<void> {
  return mounted === null || mounted.sessionId !== sessionId
    ? Promise.reject(new BridgeViewGoneError())
    : mounted.handle.postBridgeMessage(json)
}

export function acquireRetainedOrCreateBridgeHost(args: {
  client: RpcClient
  buildId: string
  sessionId: string
  snapshot: PageHostSnapshot
  latest: MobileWebShellBridgeArgs
  clientId: string | null
  sessionBack?: BridgeSessionBack
  readMountedView: () => MountedBridgeView | null
  setWritingFromPage: (writing: boolean) => void
}): { host: BridgeHost; binding: RetainedBridgeHostBinding } {
  const { client, buildId, sessionId, snapshot, latest, clientId, sessionBack, readMountedView } =
    args
  const postToMounted = (json: string): Promise<void> =>
    postToMountedBridgeView(readMountedView(), sessionId, json)
  const resumed = takeRetainedBridgeHost({
    hostId: latest.hostId,
    sessionId,
    buildId,
    client,
    sessionEstablished: latest.sessionEstablished
  })
  if (resumed !== null) {
    const { host, binding } = resumed
    binding.args = latest
    binding.clientId = clientId
    binding.disposed = false
    binding.post = postToMounted
    if (readMountedView()?.sessionId === sessionId) {
      flushRetainedBridgeFrames(binding, postToMounted)
    }
    return { host, binding }
  }
  const binding: RetainedBridgeHostBinding = {
    args: latest,
    clientId,
    post: postToMounted,
    queuedOutboundFrames: [],
    disposed: false,
    overflowed: false
  }
  const host = createBridgeHost({
    client,
    buildId,
    sessionId,
    route: latest.route,
    safeAreaInsets: latest.safeAreaInsets,
    keyboardInset: latest.keyboardInset,
    pageRoutes: latest.pageRoutes,
    pageRouteGrants: latest.pageRouteGrants,
    routeGrants: latest.routeGrants,
    ownsHostArea: latest.ownsHostArea === true,
    sessionEstablished: latest.sessionEstablished,
    ...(sessionBack === undefined ? {} : { sessionBack }),
    host: snapshot.host,
    readClientIdentity: () => binding.clientId,
    post: (json) =>
      postOrQueueRetainedBridgeFrame(binding, json, () => new BridgeViewGoneError()),
    onDiagnostic: createBridgeDiagnosticReporter((diagnostic) => {
      const line = bridgeDiagnosticLine(diagnostic)
      if (line !== null) {
        recordShellLifecycleLine(binding.args.hostId, line)
      }
    }),
    onNavigate: (href) => binding.args.onNavigate(href),
    onNavigateBack: () => binding.args.onNavigateBack(),
    onExternalLink: (url) => binding.args.onExternalLink(url),
    onHaptic: (kind) => binding.args.onHaptic(kind),
    serveNativeVerb: (verb, params) => binding.args.serveNativeVerb(verb, params),
    readStorage: () => binding.args.readStorage(),
    onStorageWrite: (key, value) => {
      args.setWritingFromPage(true)
      try {
        binding.args.onStorageWrite(key, value)
      } finally {
        args.setWritingFromPage(false)
      }
    },
    onPageFault: (error) => binding.args.onPageFault(error),
    onRouteParamClear: (param, value) => binding.args.onRouteParamClear(param, value),
    onRouteRefused: (issue) => binding.args.onRouteRefused(issue),
    onBinaryFramesDropped: (total) => binding.args.onBinaryFramesDropped(total),
    onPageReady: () => binding.args.onPageReady(),
    onPagePainted: () => binding.args.onPagePainted(),
    onPageBackClaim: (claimed) => binding.args.onPageBackClaim(claimed)
  })
  latest.onBinaryFramesDropped(0)
  return { host, binding }
}

export function releaseOrParkBridgeHost(args: {
  hostId: string
  sessionId: string
  buildId: string
  client: object
  host: BridgeHost
  binding: RetainedBridgeHostBinding
}): void {
  if (!parkRetainedBridgeHost(args)) {
    args.host.dispose()
    args.binding.post = null
    args.binding.disposed = true
  }
}

export function resetBridgeDocumentBindings(
  binding: RetainedBridgeHostBinding | null,
  host: BridgeHost | null
): void {
  if (binding !== null) {
    binding.queuedOutboundFrames.length = 0
    binding.overflowed = false
  }
  host?.resetDocument()
}
