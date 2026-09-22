import type { ConnectionState, RpcResponse } from '../transport/types'
import { BridgeCapExceededError, BridgeReplyUndeliverableError } from './bridge-host-errors'
import { createNativeVerbServer } from './bridge-host-native-verbs'
import { BridgeHostRequests } from './bridge-host-requests'
import { BridgeHostSubscriptions } from './bridge-host-subscriptions'
import { createBridgeHostStreamFrames } from './bridge-host-stream-frames'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { BRIDGE_SHELL_ACCEPTS, createBridgeInitFrame } from './bridge/bridge-init-frame'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'
import { createBridgeHostFrames } from './bridge-host-frames'
import { createBridgeHostBack, type BridgeSessionBack } from './bridge-host-back'
import { createBridgeNotifyForwarder } from './bridge-host-notify'
import { createBridgeHostRoute } from './bridge-host-route'
import type { BridgeHostOptions } from './bridge-host-contract'

// Re-exported so a caller reaches the host and what it reports through one module.
export type { BridgeHostDiagnostic, BridgeHostOptions } from './bridge-host-contract'

export type BridgeHost = {
  receive: (json: string) => void
  /**
   * Hands this session a rewritten route: same screen, different params (ruling 33.1).
   *
   * The held route moves either way, so a page that reloads inside this mount is told the newest
   * one; the frame goes out only to a page that declared `BRIDGE_ROUTE_UPDATE_ACCEPT`, because a
   * page too old to name it reads a second `init` as a replacement. A different pathname is a
   * different screen and is refused here — that is a remount, which is what the shell already does.
   *
   * Answers nothing, and nothing is tracked (ruling 34): a frame the view refused is repaired by
   * the next `init`, and the request it carried is spent by the page, which erases the param it
   * applied.
   */
  publishRoute: (next: BridgeInitRoute) => void
  /**
   * Hands the page one Back press. False when this document never said it takes one, which is
   * every page older than the frame; the caller then leaves the key to the navigator.
   */
  sendBack: () => boolean
  /**
   * What this session has established about the Back key, for the host that takes over.
   *
   * A host is rebuilt when the client under it changes and the page document does not move, so
   * what the page declared and what it is holding outlive this object. Read at teardown and handed
   * to the replacement; a caller that is ending the session simply drops it.
   */
  readSessionBack: () => BridgeSessionBack
  dispose: () => void
}

/**
 * One page document's end of the bridge: page frames in, host frames out, one RPC client behind it.
 *
 * The fence is structural rather than checked. The protocol names no host, so a page cannot ask for
 * one: the client is whichever this host was built with, and a page that outlives its session has
 * its frames refused at the native origin check before this module ever sees them. The caps the
 * page is told about in `init` are enforced here and not trusted from there.
 */
export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { client, buildId, sessionId, pageRoutes, host } = options
  // The protocol's own grant rides with every session; the rest is what this route asked for.
  const granted: readonly string[] = [BRIDGE_FAULT_GRANT, ...options.routeGrants]
  // Checked here for the reason the route is: a pair the page's reader would refuse takes the whole
  // `init` with it, and a session that never gets one is worse than one that never starts.
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
    onRefused: (issue) => options.onDiagnostic?.({ kind: 'route-update-refused', issue })
  })
  let closed = false
  // One document's turn at the bridge. `close` ends it and the next `ready` begins the next one;
  // between the two the view belongs to no document, so nothing is served and nothing is posted.
  // No epoch rides along: one native listener delivers page frames in order, so a straggler from
  // the closed document is always behind it and ahead of the next document's `ready`.
  let serving = true
  // Whether this host has ever answered a `ready`. Not the same as `serving`, which starts true so
  // the first document's frames are not refused for arriving in the same batch as its `ready`: this
  // one starts false, because a page that has been told no grants holds none.
  // Seeded from the session rather than started false: this host may be a rebuild taking over a
  // session that handshook with the one before it.
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

  /** `state` is the event's own value: a listener can run before the getter it mirrors is updated. */
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
          pageRoutes,
          ...(parsedRouteGrants?.success === true
            ? { pageRouteGrants: parsedRouteGrants.data }
            : {}),
          granted,
          accepts: BRIDGE_SHELL_ACCEPTS,
          host,
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

  const back = createBridgeHostBack({
    send,
    // The same three the outbound frames are gated on, read here as well: the caller spends the
    // answer on a hardware key, and a `true` for a frame that never left is a dead press.
    deliverable: () => !closed && serving && initSent,
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

  /** Cancels everything the page had open. `notify` is false for the page's own `close`, which has
   *  already settled what it owned. */
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
    // `ready` is what claims the view, whether it is the first document's or a replacement's; a
    // re-asked `ready` from the document already being served is answered the same way.
    if (message.type === 'ready') {
      serving = true
      routes.readReady(message)
      back.readReady(message.accepts ?? [])
      // Every time it is asked, not once: the page re-asks on a backoff, and each ask is answered
      // with the route the shell holds now. That is the whole repair path for a frame that never
      // arrived (ruling 34) — nothing here waits on one, and nothing retries one.
      sendInit()
      // Forwarded verbatim, including a name this shell has never implemented: what each report
      // means is the caller's, and this host's job is that the list belongs to the document that
      // just spoke rather than to the one before it.
      options.onPageReady(message.reports ?? [])
      return
    }
    if (!serving) {
      options.onDiagnostic?.({ kind: 'frame-after-close' })
      return
    }
    // A page whose session has never handshook has been told no caps, no grants and no route, so
    // anything it opens is a frame from a document nothing has answered. The notify path has
    // refused that since C0 under the same name; requests and streams did not. Keyed on the
    // session, so a host rebuilt under a live page serves it rather than refusing until reload.
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
        // Not a latch. The document that loads next into this same view says `ready` over this same
        // host, and a host that had shut itself would leave that `ready` retrying forever.
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
    // At construction rather than on the first `ready`: the verdict does not depend on the page
    // behaving, and a shell that waited for a frame would hold a blank view until one arrived.
    const issue = routeGrantsIssue ? `pageRouteGrants: ${routeGrantsIssue}` : routes.openIssue()
    options.onDiagnostic?.({ kind: 'route-refused', issue })
    options.onRouteRefused(issue)
  }

  return {
    receive(json: string): void {
      if (closed) {
        // Only a disposed host reaches this, and it can neither answer the frame nor refuse it.
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
    sendBack: back.send,
    readSessionBack: back.read,
    dispose
  }
}
