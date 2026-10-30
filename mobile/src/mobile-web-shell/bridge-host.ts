import type { ConnectionState, RpcResponse } from '../transport/types'
import { BridgeCapExceededError, BridgeReplyUndeliverableError } from './bridge-host-errors'
import { createNativeVerbServer } from './bridge-host-native-verbs'
import { BridgeHostRequests } from './bridge-host-requests'
import { BridgeHostSubscriptions } from './bridge-host-subscriptions'
import { createBridgeHostStreamFrames } from './bridge-host-stream-frames'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_ENVELOPE_GRANT,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeColorScheme,
  type BridgeUiLocale,
  type BridgeConnectionSnapshot,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { createBridgeInitFrame } from './bridge/bridge-init-frame'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'
import { createBridgeHostFrames } from './bridge-host-frames'
import { createBridgeHostBack, type BridgeSessionBack } from './bridge-host-back'
import { createBridgeNotifyForwarder } from './bridge-host-notify'
import { createBridgeHostRoute } from './bridge-host-route'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import type { BridgeHostOptions } from './bridge-host-contract'

export type { BridgeHostDiagnostic, BridgeHostOptions } from './bridge-host-contract'

export type BridgeHost = {
  receive: (json: string) => void
  // Hold same-screen param updates even when posting fails; repair from the next ready without delivery tracking. Different pathnames require remount; the page clears consumed params (rulings 33.1/34).
  publishRoute: (next: BridgeInitRoute) => void
  publishSafeAreaInsets: (next: BridgeSafeAreaInsets) => void
  publishKeyboardInset: (next: number) => void
  publishColorScheme: (next: BridgeColorScheme) => void
  publishUiLocale: (next: BridgeUiLocale) => void
  // False leaves Back to native navigation, including pages predating this frame.
  sendBack: () => boolean
  // Transfer the session’s Back state on client-driven host rebuild; the mounted page never reclaims it. Ending sessions simply discard it.
  readSessionBack: () => BridgeSessionBack
  dispose: () => void
}

// Bind the host structurally to one RPC client; the protocol lets pages name no other host. Native origin checks reject expired sessions, and init caps are enforced here.
export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { client, buildId, sessionId, pageRoutes, host } = options
  const granted: readonly string[] = [
    BRIDGE_FAULT_GRANT,
    BRIDGE_RPC_ENVELOPE_GRANT,
    ...options.routeGrants
  ]
  // Validate manifest pairs like the route: a pair refused by the page would invalidate the entire init.
  const parsedRouteGrants =
    options.pageRouteGrants === undefined
      ? null
      : BridgePageRouteGrantsSchema.safeParse(options.pageRouteGrants)
  const routeGrantsIssue =
    parsedRouteGrants !== null && !parsedRouteGrants.success
      ? (parsedRouteGrants.error.issues[0]?.message ?? 'unknown')
      : null
  const routes = createBridgeHostRoute({
    opened: options.route,
    refused: routeGrantsIssue !== null,
    sendInit: () => {
      sendInit()
    },
    onRefused: (issue) => options.onDiagnostic?.({ kind: 'route-update-refused', issue }),
    ...(options.safeAreaInsets === undefined ? {} : { safeAreaInsets: options.safeAreaInsets }),
    ...(options.keyboardInset === undefined ? {} : { keyboardInset: options.keyboardInset }),
    ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
    ...(options.uiLocale === undefined ? {} : { uiLocale: options.uiLocale })
  })
  let closed = false
  // Close ends document service until the next ready. Native delivery preserves frame order, so stragglers remain between those markers without an epoch.
  let serving = true
  // serving initially admits the first ready batch, but only an established session holds grants. Inherit establishment when rebuilding beneath a live page.
  let initSent = options.sessionEstablished

  const frames = createBridgeHostFrames({
    post: options.post,
    isOpen: () => !closed && serving,
    onDiagnostic: options.onDiagnostic
  })
  const { postJson, sendJson, send, sendError } = frames

  const subscriptions = new BridgeHostSubscriptions({
    client,
    post: sendJson,
    onBinaryFrameDropped: ({ id, bytes, droppedOnStream }) => {
      options.onDiagnostic?.({ kind: 'binary-frame-dropped', id, bytes, dropped: droppedOnStream })
      options.onBinaryFramesDropped?.(subscriptions.droppedBinaryFrames)
    },
    onTerminalBacklog: (report) => {
      options.onDiagnostic?.({ kind: 'terminal-backlog', ...report })
    },
    terminalTimers: options.terminalTimers
  })

  // Use the event’s state; listeners can run before the mirrored getter updates.
  function snapshot(state?: ConnectionState): BridgeConnectionSnapshot {
    return {
      state: state ?? client.getState(),
      reconnectAttempt: client.getReconnectAttempt(),
      lastConnectedAt: client.getLastConnectedAt(),
      lastInboundAt: client.getLastInboundAt?.() ?? null,
      generation: client.getGeneration?.() ?? null
    }
  }

  // Build init synchronously for first-render/golden timing; reread route, client state and storage on every ready, including reloads after writes.
  // Refused routes send nothing; failed posts produce one diagnostic with no held frame or retry. The page’s next ready repairs state (ruling 34).
  function sendInit(): void {
    const route = routes.current()
    if (route === null) {
      return
    }
    initSent = true
    void postJson(
      JSON.stringify(
        createBridgeInitFrame({
          sessionId,
          buildId,
          connection: snapshot(),
          route,
          safeAreaInsets: routes.safeAreaInsets(),
          keyboardInset: routes.keyboardInset(),
          colorScheme: routes.colorScheme(),
          uiLocale: routes.uiLocale(),
          pageRoutes,
          ...(parsedRouteGrants?.success === true
            ? { pageRouteGrants: parsedRouteGrants.data }
            : {}),
          granted,
          host,
          ownsHostArea: options.ownsHostArea === true,
          ...options.readStorage()
        })
      )
    )
  }

  function sendReply(id: string, payload: RpcResponse): void {
    const split = splitBridgeReply(id, payload)
    if (!split.ok) {
      sendError(id, new BridgeReplyUndeliverableError(split.refusal))
      return
    }
    for (const frame of split.frames) {
      send(frame)
    }
  }

  const requests = new BridgeHostRequests({
    client,
    isIdTaken: (id) => subscriptions.has(id),
    sendReply,
    sendError,
    capExceeded: (message) => new BridgeCapExceededError(message),
    readClientIdentity: () => options.readClientIdentity(),
    serveNative: createNativeVerbServer({
      granted,
      serveVerb: (verb, params) => options.serveNativeVerb(verb, params)
    })
  })

  const streamFrames = createBridgeHostStreamFrames({
    requests,
    subscriptions,
    sendError,
    granted,
    readClientIdentity: () => options.readClientIdentity(),
    report: (diagnostic) => options.onDiagnostic?.(diagnostic)
  })

  // Check the outbound gates before consuming native Back; returning true for an unsent frame would swallow the key.
  const deliverable = (): boolean => !closed && serving && initSent

  const back = createBridgeHostBack({
    send,
    deliverable,
    onClaim: (claimed) => options.onPageBackClaim(claimed),
    ...(options.sessionBack === undefined ? {} : { established: options.sessionBack })
  })

  const forwardNotify = createBridgeNotifyForwarder({
    options,
    granted,
    initSent: () => initSent,
    route: () => routes.current(),
    onBackClaim: back.readClaim
  })

  function settleAll(notify: boolean): void {
    requests.closeAll(notify)
    subscriptions.closeAll(notify ? 'closed' : null)
  }

  function dispose(): void {
    if (closed) {
      return
    }
    settleAll(true)
    closed = true
    unsubscribeState()
  }

  function dispatch(message: BridgeClientMessage): void {
    // Every ready claims the view, whether a new document or a repeated ask.
    if (message.type === 'ready') {
      serving = true
      back.readReady()
      // Answer every ready with current state; this repairs missed frames without host retries (ruling 34).
      sendInit()
      options.onPageReady()
      return
    }
    if (!serving) {
      options.onDiagnostic?.({ kind: 'frame-after-close' })
      return
    }
    // A session with no handshake has no grants/caps; refuse requests and streams too. Inherited handshake state keeps client-rebuilt hosts serving live pages.
    if (!initSent && (message.type === 'request' || message.type === 'subscribe')) {
      options.onDiagnostic?.({ kind: 'notify-refused', name: message.method, why: 'before-ready' })
      sendError(message.id, new BridgeCapExceededError('before-ready'))
      return
    }
    switch (message.type) {
      case 'request':
        requests.open(message)
        return
      case 'subscribe':
        streamFrames.open(message)
        return
      case 'cancel': {
        if (message.target === 'subscription') {
          streamFrames.cancel(message.id)
          return
        }
        requests.cancel(message.id)
        return
      }
      case 'ack':
        streamFrames.ack(message.id, message.seq)
        return
      case 'notify':
        forwardNotify(message)
        return
      case 'close':
        // Close is not host disposal; the next document sends ready over this same view.
        settleAll(false)
        serving = false
        back.drop()
        return
    }
  }

  const unsubscribeState = client.onStateChange((state) => {
    send({ v: BRIDGE_PROTOCOL_VERSION, type: 'state', connection: snapshot(state) })
  })

  if (routes.current() === null) {
    // Report invalid routes at construction so recovery does not depend on a blank page producing a frame.
    const issue = routeGrantsIssue ? `pageRouteGrants: ${routeGrantsIssue}` : routes.openIssue()
    options.onDiagnostic?.({ kind: 'route-refused', issue })
    options.onRouteRefused(issue)
  }

  return {
    receive(json: string): void {
      if (closed) {
        options.onDiagnostic?.({ kind: 'frame-after-dispose' })
        return
      }
      const read = readBridgeClientMessage(json)
      if (!read.ok) {
        options.onDiagnostic?.({ kind: 'refused', refusal: read.refusal })
        return
      }
      dispatch(read.message)
    },
    publishRoute: (next) => {
      routes.publish(next, serving && initSent)
    },
    publishSafeAreaInsets: (next) => {
      routes.publishSafeAreaInsets(next, deliverable())
    },
    publishKeyboardInset: (next) => {
      routes.publishKeyboardInset(next, deliverable())
    },
    publishColorScheme: (next) => {
      routes.publishColorScheme(next, deliverable())
    },
    publishUiLocale: (next) => {
      routes.publishUiLocale(next, deliverable())
    },
    sendBack: back.send,
    readSessionBack: back.read,
    dispose
  }
}
