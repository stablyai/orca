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
  type BridgeConnectionSnapshot
} from './bridge/bridge-envelope'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { createBridgeInitFrame } from './bridge/bridge-init-frame'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'
import { createBridgeHostFrames } from './bridge-host-frames'
import { createBridgeHostBack } from './bridge-host-back'
import { createBridgeNotifyForwarder } from './bridge-host-notify'
import { createBridgeHostRoute } from './bridge-host-route'
import { pageStorageForReader } from './page-storage-keys'
import { BRIDGE_TERMINAL_KEY_FRAME } from './bridge/bridge-terminal-key'
import type { BridgeHost, BridgeHostOptions } from './bridge-host-contract'

export type { BridgeHost, BridgeHostDiagnostic, BridgeHostOptions } from './bridge-host-contract'

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
    ...(options.pageGeometry === undefined ? {} : { pageGeometry: options.pageGeometry }),
    ...(options.foldDivision === undefined ? {} : { foldDivision: options.foldDivision }),
    ...(options.terminalKeyRail === undefined ? {} : { terminalKeyRail: options.terminalKeyRail }),
    ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
    ...(options.uiLocale === undefined ? {} : { uiLocale: options.uiLocale })
  })
  let closed = false
  // Close ends document service until the next ready. Native delivery preserves frame order, so stragglers remain between those markers without an epoch.
  let serving = true
  // serving initially admits the first ready batch, but only an established session holds grants. Inherit establishment when rebuilding beneath a live page.
  let initSent = options.sessionEstablished
  // What the page's init reader accepts, carried across a rebuild because the page does not
  // re-handshake. Null is a page older than `storageKeys`, which gets the legacy keys only.
  let pageStorageKeys: readonly string[] | null = options.sessionBack?.storageKeys ?? null

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

  /**
   * Posts `init`, and answers nothing (ruling 34).
   *
   * Sent every time it is asked for, with the keys read every time it is sent. A page that saw a
   * `state` older than the one it holds recovers by asking again rather than by living with a
   * cache it knows is wrong, and the same is true of its storage: a document that reloads inside
   * one mount — which the fault path produces — would otherwise be primed from before its own
   * writes, and `publishPageStorage` clears the page's cache to match.
   *
   * The frame is built synchronously, because the page refuses every member until `init` lands and
   * the golden recorder mounts its screen in the same turn it drains one; a frame whose contents
   * waited on a promise would change what the first render of every replay sees.
   *
   * A refused route sends nothing at all, and a post the view would not take is one diagnostic and
   * no further attempt: nothing here holds a frame, and nothing retries one.
   */
  function sendInit(refreshTerminalShortcuts = false): void {
    const route = routes.current()
    if (route === null || (refreshTerminalShortcuts && !deliverable())) {
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
          pageGeometry: routes.pageGeometry(),
          foldDivision: routes.foldDivision(),
          terminalKeyRail: routes.terminalKeyRail(),
          colorScheme: routes.colorScheme(),
          uiLocale: routes.uiLocale(),
          pageRoutes,
          ...(parsedRouteGrants?.success === true
            ? { pageRouteGrants: parsedRouteGrants.data }
            : {}),
          granted,
          host,
          ownsHostArea: options.ownsHostArea === true,
          ...pageStorageForReader(options.readStorage(), pageStorageKeys),
          refreshTerminalShortcuts
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

  let railOwner = options.sessionBack?.terminalKeyRailClaim?.inputOwner
  let railClaimed = options.sessionBack?.terminalKeyRailClaim !== undefined
  type RailClaim = NonNullable<BridgeHostOptions['onTerminalKeyRailClaim']>
  const reportRailClaim: RailClaim = (claimed, inputOwner, toolbar) => {
    railClaimed = claimed
    railOwner = claimed ? inputOwner : undefined
    options.onTerminalKeyRailClaim?.(claimed, inputOwner, toolbar)
  }
  const forwardNotify = createBridgeNotifyForwarder({
    options,
    granted,
    initSent: () => initSent,
    route: () => routes.current(),
    onBackClaim: back.readClaim,
    onTerminalKeyRailClaim: reportRailClaim
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
      pageStorageKeys = message.storageKeys ?? null
      back.readReady()
      // Dropped like the Back claim: a page still showing a terminal claims again on this `init`.
      reportRailClaim(false)
      // Every time it is asked, not once: the page re-asks on a backoff, and each ask is answered
      // with the route the shell holds now. That is the whole repair path for a frame that never
      // arrived (ruling 34) — nothing here waits on one, and nothing retries one.
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
        reportRailClaim(false)
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
    publishRoute: (next) => routes.publish(next, serving && initSent),
    publishSafeAreaInsets: (next) => {
      routes.publishSafeAreaInsets(next, deliverable())
    },
    publishKeyboardInset: (next) => routes.publishKeyboardInset(next, deliverable()),
    publishStorage: () => sendInit(true),
    publishPageGeometry: (next) => routes.publishPageGeometry(next, deliverable()),
    publishFoldDivision: (next) => routes.publishFoldDivision(next, deliverable()),
    publishTerminalKeyRail: (next) => routes.publishTerminalKeyRail(next, deliverable()),
    sendTerminalKey: (key, inputOwner) => {
      if (!railClaimed || inputOwner !== railOwner || !deliverable()) {
        return false
      }
      send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: BRIDGE_TERMINAL_KEY_FRAME,
        key,
        inputOwner
      })
      return true
    },
    publishColorScheme: (next) => {
      routes.publishColorScheme(next, deliverable())
    },
    publishUiLocale: (next) => {
      routes.publishUiLocale(next, deliverable())
    },
    sendBack: back.send,
    readSessionBack: () => ({
      ...back.read(),
      ...(pageStorageKeys === null ? {} : { storageKeys: pageStorageKeys }),
      ...(railClaimed ? { terminalKeyRailClaim: { inputOwner: railOwner } } : {})
    }),
    dispose
  }
}
