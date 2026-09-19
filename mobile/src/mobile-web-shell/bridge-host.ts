import type { ConnectionState, RpcResponse } from '../transport/types'
import { BridgeCapExceededError, BridgeReplyUndeliverableError } from './bridge-host-errors'
import { BridgeHostRequests } from './bridge-host-requests'
import { BridgeHostSubscriptions } from './bridge-host-subscriptions'
import { BRIDGE_MAX_SUBSCRIPTIONS } from './bridge/bridge-caps'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION,
  BridgeInitRouteSchema,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage
} from './bridge/bridge-envelope'
import { captureBridgeError } from './bridge/bridge-error-capture'
import { BRIDGE_NATIVE_GRANTS, createBridgeInitFrame } from './bridge/bridge-init-frame'
import { bridgeNotifyRefusal } from './bridge/bridge-notify-grants'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'
import { isPageStorageKeyForHost } from './page-storage-keys'
import type { BridgeHostOptions } from './bridge-host-contract'

// Re-exported so a caller reaches the host and what it reports through one module.
export type { BridgeHostDiagnostic, BridgeHostOptions } from './bridge-host-contract'

type SubscribeMessage = Extract<BridgeClientMessage, { type: 'subscribe' }>
type NotifyMessage = Extract<BridgeClientMessage, { type: 'notify' }>

export type BridgeHost = {
  receive: (json: string) => void
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
  // Parsed here, once, against the same schema the page reads it with. The producer interpolates a
  // host id into a pathname, so a host id carrying `?`, `#`, whitespace or a dot segment reaches
  // the wire as a route no page will accept; without this the page refuses the whole `init`, asks
  // again on its backoff forever, and the shell un-hides a WebView that will never paint.
  const parsedRoute = BridgeInitRouteSchema.safeParse(options.route)
  const route = parsedRoute.success ? parsedRoute.data : null
  let closed = false
  // One document's turn at the bridge. `close` ends it and the next `ready` begins the next one;
  // between the two the view belongs to no document, so nothing is served and nothing is posted.
  // No epoch rides along: one native listener delivers page frames in order, so a straggler from
  // the closed document is always behind it and ahead of the next document's `ready`.
  let serving = true
  // Whether this host has ever answered a `ready`. Not the same as `serving`, which starts true so
  // the first document's frames are not refused for arriving in the same batch as its `ready`: this
  // one starts false, because a page that has been told no grants holds none.
  let initSent = false
  let postFailureReported = false
  let notifyFailureReported = false

  // Once per session: a page that cannot be posted to fails every frame after the first, and a
  // line per frame buries the one that says why.
  function reportPostFailure(error: unknown): void {
    if (postFailureReported) {
      return
    }
    postFailureReported = true
    options.onDiagnostic?.({ kind: 'post-failed', error })
  }

  function sendJson(json: string): void {
    // Defensive: teardown already settles everything that could post; this fences callers added later.
    if (closed) {
      return
    }
    // Between documents the view still exists and still accepts posts, which is exactly why this is
    // checked: a `state` frame sent now lands in the next document before it has said `ready`.
    if (!serving) {
      return
    }
    // A `post` that throws where it should reject would escape into the client's own state-change
    // fan-out, which is what sends the `state` frame, and take the other listeners down with it.
    try {
      void options.post(json).catch(reportPostFailure)
    } catch (error) {
      reportPostFailure(error)
    }
  }

  // Every value in a host frame has already been serialized by whoever produced it — a reply by
  // `splitBridgeReply`, an error `code` by the capture's round trip — so this cannot throw.
  function send(frame: BridgeHostMessage): void {
    sendJson(JSON.stringify(frame))
  }

  function sendError(id: string, error: unknown): void {
    send({ v: BRIDGE_PROTOCOL_VERSION, type: 'error', id, error: captureBridgeError(error) })
  }

  const subscriptions = new BridgeHostSubscriptions({ client, post: sendJson })

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
   * Answered every time it is asked, with the keys read every time it is answered.
   *
   * A page that saw a `state` older than the one it holds recovers by asking again rather than by
   * living with a cache it knows is wrong, and the same is true of its storage: a document that
   * reloads inside one mount — which the fault path produces — would otherwise be primed from
   * before its own writes, and `publishPageStorage` clears the page's cache to match.
   *
   * Synchronously, because the page refuses every member until `init` lands and the golden
   * recorder mounts its screen in the same turn it drains one; an `init` that waited on a promise
   * would change what the first render of every replay sees. The caller keeps the map current.
   */
  function sendInit(): void {
    if (route === null) {
      return
    }
    initSent = true
    send(
      createBridgeInitFrame({
        sessionId,
        buildId,
        connection: snapshot(),
        route,
        pageRoutes,
        host,
        storage: options.readStorage()
      })
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
    capExceeded: (message) => new BridgeCapExceededError(message)
  })

  // `wantsBinary` is read by the contract and acted on in C6, which owns the screencast encoder and
  // the measurement that earns it. Until then every stream crosses as JSON.
  function handleSubscribe(message: SubscribeMessage): void {
    const { id } = message
    if (requests.has(id) || subscriptions.has(id)) {
      sendError(id, new BridgeCapExceededError('that id is already in flight'))
      return
    }
    if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
      sendError(id, new BridgeCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`))
      return
    }
    try {
      subscriptions.start(id, message.method, message.params)
    } catch (error) {
      sendError(id, error)
    }
  }

  /** The client's own work runs inside these calls, and a throw from one would otherwise escape into
   *  the native event handler that delivered the page's frame. Nothing is owed to the page here. */
  function forwardNotify(message: NotifyMessage): void {
    const refusal = bridgeNotifyRefusal({
      name: message.name,
      initSent,
      granted: BRIDGE_NATIVE_GRANTS
    })
    if (refusal !== null) {
      options.onDiagnostic?.({ kind: 'notify-refused', name: message.name, why: refusal })
      return
    }
    try {
      if (message.name === BRIDGE_FAULT_GRANT) {
        // Not the client's: a page that threw is this session's problem, and the desktop on the
        // other end of the client has nothing to do with it.
        options.onPageFault(message.error)
        return
      }
      if (message.name === 'foreground') {
        if (message.reason === undefined) {
          client.notifyForeground()
        } else {
          client.notifyForeground(message.reason)
        }
        return
      }
      if (message.name === 'navigate') {
        // Not routed to the client: this one never leaves the phone. The page asked for a screen
        // it does not render, and the caller pushes it over the still-mounted view.
        options.onNavigate(message.href)
        return
      }
      if (message.name === BRIDGE_NAVIGATE_BACK_NOTIFY) {
        // Local too, and the one notify with no argument: the shell pops what it pushed. A pop the
        // shell did not make is reported rather than answered, because the page is told nothing
        // either way and a Back button that does nothing is what would otherwise go unnoticed.
        const outcome = options.onNavigateBack()
        if (outcome !== 'popped') {
          options.onDiagnostic?.({ kind: 'navigate-back-refused', why: outcome })
        }
        return
      }
      if (message.name === 'storage') {
        // Also local, and held to this host's own keys. The envelope allowlists the shape before
        // this runs, which lets `orca:pins:<any host>` through: a page opened for one host must
        // not rewrite another's pinned list, and the keys it was handed are the ones it may write.
        if (!isPageStorageKeyForHost(message.key, host.id)) {
          options.onDiagnostic?.({ kind: 'storage-refused', key: message.key })
          return
        }
        options.onStorageWrite(message.key, message.value)
        return
      }
      client.updateTerminalSubscriptionViewport(message.terminal, {
        cols: message.cols,
        rows: message.rows
      })
    } catch (error) {
      // Once per session, for the reason a failing post is: a page nudging a broken listener nudges
      // it again on every foreground.
      if (notifyFailureReported) {
        return
      }
      notifyFailureReported = true
      options.onDiagnostic?.({ kind: 'notify-failed', error })
    }
  }

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
      sendInit()
      // Every time it is asked, not once: the page re-asks on a backoff, and the shell's wait ends
      // on the first of those that lands rather than on a particular one.
      options.onPageReady()
      return
    }
    if (!serving) {
      options.onDiagnostic?.({ kind: 'frame-after-close' })
      return
    }
    switch (message.type) {
      case 'request':
        requests.open(message)
        return
      case 'subscribe':
        handleSubscribe(message)
        return
      case 'cancel': {
        if (message.target === 'subscription') {
          subscriptions.cancel(message.id, 'unsubscribed')
          return
        }
        requests.cancel(message.id)
        return
      }
      case 'ack':
        subscriptions.ack(message.id, message.seq)
        return
      case 'notify':
        forwardNotify(message)
        return
      case 'close':
        // Not a latch. The document that loads next into this same view says `ready` over this same
        // host, and a host that had shut itself would leave that `ready` retrying forever.
        settleAll(false)
        serving = false
        return
    }
  }

  const unsubscribeState = client.onStateChange((state) => {
    send({ v: BRIDGE_PROTOCOL_VERSION, type: 'state', connection: snapshot(state) })
  })

  if (route === null) {
    // At construction rather than on the first `ready`: the verdict does not depend on the page
    // behaving, and a shell that waited for a frame would hold a blank view until one arrived.
    const issue = parsedRoute.success
      ? 'unknown'
      : (parsedRoute.error.issues[0]?.message ?? 'unknown')
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
    dispose
  }
}
