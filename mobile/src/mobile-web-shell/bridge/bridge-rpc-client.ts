import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { RpcClient, SendRequestOptions } from '../../transport/rpc-client'
import type { ConnectionState, RpcResponse, RpcSuccess } from '../../transport/types'
import {
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS,
  isBridgeFrameWithinCap,
  utf8ByteLength
} from './bridge-caps'
import { BridgeConnectionCache } from './bridge-client-connection-cache'
import type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'
import { createBridgeClientShellSession } from './bridge-client-shell-session'
import type { BridgeShellSession } from './bridge-client-session'
import { createBridgeInitHandshake } from './bridge-client-init-handshake'
import {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotNativeVerbError,
  BridgeClientNotReadyError,
  BridgeRequestOversizedError,
  BridgeSendFailedError,
  BridgeShellReplacedError
} from './bridge-client-errors'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import { createBridgeInboundFrameReader } from './bridge-client-inbound-frames'
import { createBridgeClientNotifications } from './bridge-client-notifications'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { BridgeClientRequests } from './bridge-client-requests'
import { BridgeClientSubscriptions } from './bridge-client-subscriptions'
import { isBridgeNativeMethod, type BridgeNativeVerb } from './bridge-native-verbs'
import {
  BRIDGE_ROUTE_PARAM_CLEAR,
  BRIDGE_ROUTE_UPDATE_ACCEPT,
  type BridgeClearableRouteParam
} from './bridge-route-update'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage,
  type BridgeInitRoute
} from './bridge-envelope'

export type { BridgeShellSession } from './bridge-client-session'

export {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeReplyRefusedError,
  BridgeRequestOversizedError,
  BridgeSendFailedError,
  BridgeShellReplacedError
} from './bridge-client-errors'

/** Base64url, and the length the envelope's id pattern requires. Base36 digits are a subset of it. */
const BRIDGE_ID_CHARS = 22

export type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'

export type BridgeRpcClientOptions = {
  /** Posts one frame to the shell. May throw; nothing about returning proves delivery. */
  send: (json: string) => void
  onMessage: (handler: (json: string) => void) => () => void
  onDiagnostic?: (diagnostic: BridgeRpcClientDiagnostic) => void
}

export type BridgeRpcClient = RpcClient & {
  /** Fires once `init` has landed, immediately if it already has. Mount no screen before it. */
  onReady: (listener: () => void) => () => void
  /**
   * Fires each time the shell rewrites a param of the screen this page is already on, which is a
   * second `init` for the session it already holds. Never for the first one, and never for a
   * re-sent `init` whose route is the one the page already holds — a re-asked `ready` is answered
   * with that route and is not a request.
   *
   * One delivery per tap rather than one per distinct value: the shell clears the param after each
   * delivery, so a notification tap for the pane already showing arrives as a real move and a
   * listener that deduplicated by value would lose exactly that one.
   */
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  getShellSession: () => BridgeShellSession | null
  /**
   * Asks the shell to open a screen this page does not render. False when the shell granted no
   * `navigate`, which is an older shell that would refuse the frame outright: the caller then has
   * to do something else, and a thrown error in a tap handler is not that.
   */
  notifyNavigate: (href: string) => boolean
  /**
   * Asks the shell to pop the native stack this page was pushed onto, which is the only stack a
   * document holding one history entry has. False when the shell granted no `navigate`; a shell
   * that granted one but is too old to know this verb refuses the frame instead, and neither is
   * distinguishable from here, so the caller falls back to its own router for both.
   */
  notifyNavigateBack: () => boolean
  /**
   * Asks the shell to open a URL outside the app. False when the shell granted no `externalLink`,
   * or when the URL is not one the grant covers — the caller has to do something else with it, and
   * a throw inside a tap handler is not that.
   */
  notifyExternalLink: (url: string) => boolean
  /**
   * Calls one shell-answered verb. It rides the same `request` frame, id space and in-flight cap
   * as a desktop method; the `native.` prefix is what makes the host answer it instead of
   * forwarding. It lives here rather than in a screen because that is what keeps the raw request
   * port inside the module that owns it — a native verb is bridge machinery, not an RPC to a
   * runtime, so it has no `RpcOperation` and no entry in the desktop's method catalog.
   */
  callNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<RpcSuccess>
  /**
   * Tells the shell this document has a frame on screen, which is the only thing that does: the
   * shell sees a document commit and a page say `ready`, and neither of those is a painted tree.
   * Declared in `ready.reports`, so a shell waiting for it is one this page will answer.
   */
  notifyPagePainted: () => void
  /** Writes one allowlisted key into the app's store. False when the shell granted no `storage`. */
  notifyStorageWrite: (key: string, value: string | null) => boolean
  /**
   * Asks the shell to play one haptic. False when the shell granted no `haptics`, which no caller
   * has to do anything about: a tap that did not buzz is what the page did before this existed.
   */
  notifyHaptics: (kind: BridgeHapticsKind) => boolean
  /**
   * Tells the shell this page cannot render what it was opened for. Never throws and never rejects:
   * the one caller is an error boundary, and a report that threw would be the second failure.
   *
   * False means nothing left — no session, a closed client, a shell that granted no fault
   * reporting, or a port that refused the frame. There is no second attempt: what could not be said
   * once will not say itself on a retry, and the shell's own load state is the other way it finds out.
   */
  notifyPageFault: (error: unknown) => boolean
  /**
   * Erases a one-shot route param the shell handed this page, naming the value the page applied
   * (ruling 34). The reader erases: the shell tracks no delivery, so a request stays on the route
   * and keeps arriving until the page that applied it says so.
   *
   * False when this shell never declared it takes one, which is every shell older than the field.
   * Nothing is owed the caller either way — a clear that did not leave is repaired by the request
   * arriving again, which is the same path a lost frame takes.
   */
  clearRouteParam: (param: BridgeClearableRouteParam, value: string) => boolean
}

/**
 * The page's `RpcClient`, which is a bridge and not a socket.
 *
 * Every member of the native contract is here, so `runRpcOperation` and the screens above it never
 * learn which one they hold. Two properties make that honest. The getters are synchronous reads of a
 * cache primed by `init`, because screens read them during render and an async read changes what the
 * first render sees. And `close` never closes the shell's client: that one is shared with the native
 * screens and the host catalog, so the page settles what it owns and says goodbye.
 *
 * Nothing may be called before `init`. The alternative is a stub answering `connecting` to a screen
 * that then records the wrong first render, so a call arriving early throws instead. After `close`
 * the opposite rule holds: every member goes inert and the getters keep answering the snapshot the
 * page last held, marked `disconnected`, because an unmounting screen calls into a path with no
 * catch on it. A stream the shell refuses or ends is not thrown anywhere either; it arrives as a
 * diagnostic, which is the only channel `subscribe` leaves open once it has handed back a dispose.
 */
export function createBridgeRpcClient(options: BridgeRpcClientOptions): BridgeRpcClient {
  const requests = new BridgeClientRequests()
  const cache = new BridgeConnectionCache()
  let closed = false
  let idCounter = 0

  function report(diagnostic: BridgeRpcClientDiagnostic): void {
    options.onDiagnostic?.(diagnostic)
  }

  /**
   * Posts one frame, or says why it did not leave. Never throws, which is the contract every caller
   * below depends on: a throw escaping here skips the id bookkeeping that follows the call, and the
   * slot it leaves open is one of sixty-four for the life of the page.
   *
   * `oversized` is refused here rather than by the shell, under the shell reader's own predicate:
   * the reader drops a frame over the cap and answers nothing, which would leave a request pending
   * for the life of the page.
   *
   * Serialization is inside the `try` and not before it. Every value in a page frame is one the
   * caller handed in, so `JSON.stringify` can throw on one — a `BigInt`, a cycle, a `toJSON` of its
   * own — and that throw is a send that failed, not an exception for a tap handler to discover.
   */
  function sendFrame(frame: BridgeClientMessage): 'sent' | 'oversized' | 'port-failed' {
    try {
      const json = JSON.stringify(frame)
      if (!isBridgeFrameWithinCap(json)) {
        // UTF-8 bytes, because that is the unit both shells count: `json.utf8.count` on iOS and
        // `json.toByteArray(Charsets.UTF_8).size` on Android. A code-unit count under the same name
        // understates every non-ASCII frame — a diff of CJK text is three bytes a unit.
        report({ kind: 'send-oversized', bytes: utf8ByteLength(json) })
        return 'oversized'
      }
      options.send(json)
      return 'sent'
    } catch (error) {
      report({ kind: 'send-failed', error })
      return 'port-failed'
    }
  }

  /** For the members whose contract is a boolean: a frame that did not leave is a false, whichever
   *  of the two reasons it was. */
  const posted = (frame: BridgeClientMessage): boolean => sendFrame(frame) === 'sent'

  // Counted rather than random: a recorded run replays the same ids, and one page holds one client,
  // so a counter is already unique across everything the shell is asked to keep in flight.
  function nextId(): string {
    idCounter += 1
    return idCounter.toString(36).padStart(BRIDGE_ID_CHARS, '0')
  }

  const subscriptions = new BridgeClientSubscriptions({
    send: (frame) => posted(frame),
    onDroppedBinaryFrame: () => {
      report({ kind: 'binary-frame-dropped' })
    }
  })

  const handshake = createBridgeInitHandshake(() => {
    // Declared on every ask, because the shell reads it off whichever `ready` it answers: this
    // page build knows how to take a second `init` for the session it already holds.
    // `reports` runs the other way from `accepts`: it is what a shell may wait for this page to
    // post, and the shell holds a frame over the view until the one below arrives.
    sendFrame({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'ready',
      accepts: [BRIDGE_ROUTE_UPDATE_ACCEPT],
      reports: [BRIDGE_PAGE_PAINTED]
    })
  })

  /**
   * A call before `init` is a mount-order bug and throws. A call after `close` is not: an unmounting
   * screen posts one more nudge on its way out, and the native clients answer those inertly rather
   * than throwing into a teardown path nobody wrote a catch for. Each member below says what inert
   * means for its own return type.
   */
  function requireSession(): void {
    if (shellSession.current() === null && !closed) {
      throw new BridgeClientNotReadyError()
    }
  }

  // Answers after `close` as well: what it holds is then the last snapshot, marked `disconnected`.
  function snapshot(): BridgeConnectionSnapshot {
    const held = cache.read()
    if (held === null) {
      throw new BridgeClientNotReadyError()
    }
    return held
  }

  /**
   * A second `init` is ordinary: the shell answers every `ready`, and a page that re-asked hears
   * its own session again. A different id is not, and nothing the page held survives it.
   *
   * For the same id it is a route update and nothing else (ruling 33.1). The screen is the one
   * already mounted, so every request in flight, every subscription, the storage snapshot the page
   * booted from and the generation stay exactly as they are, and only `route` moves — which is how
   * a notification tap for another pane of this session reaches a page that is already on it. The
   * session object is rebuilt only when the id changes, so the identity of what the page holds is
   * itself the assertion that nothing was replaced.
   */
  const shellSession = createBridgeClientShellSession({
    onReplaced: () => {
      const replaced = new BridgeShellReplacedError()
      requests.closeAll(replaced)
      subscriptions.failAll(replaced.message)
    },
    prime: (connection) => {
      cache.prime(connection)
    }
  })

  function acceptInit(message: Extract<BridgeHostMessage, { type: 'init' }>): void {
    handshake.stop()
    shellSession.accept(message)
  }

  /** A shell rebuilt under the page: what the cache holds is for a client that is already gone. */
  function acceptState(snapshotFromShell: BridgeConnectionSnapshot): void {
    if (cache.apply(snapshotFromShell) !== 'stale') {
      return
    }
    report({ kind: 'state-out-of-order' })
    handshake.restart()
  }

  const readInboundFrame = createBridgeInboundFrameReader({
    requests,
    subscriptions,
    report,
    acceptInit,
    acceptState
  })

  /** After `close` the page is not the document the shell is answering any more. */
  function receive(json: string): void {
    if (closed) {
      return
    }
    try {
      readInboundFrame(json)
    } catch (error) {
      // The delivery is the channel's and the handling is the page's (ruling 34 addendum). This is
      // the one place that separates them: on iOS the host's post is `callAsyncJavaScript`, so a
      // listener throwing here would reject a post for a frame the page already had, and the shell
      // would read that as a frame that never arrived. Reported and not rethrown, and not retried
      // either — the same listener would throw on the same frame again.
      report({ kind: 'inbound-listener-threw', error })
    }
  }

  function sendRequest(...args: [string, unknown?, SendRequestOptions?]): Promise<RpcResponse> {
    // A call with no session is a page bug and throws; a call over the in-flight cap is the answer
    // the shell would have posted back, so it arrives the way the shell's does, as a rejection.
    requireSession()
    if (closed) {
      // Rejected, not thrown: `bindDeferredRpcOperation` hands this promise straight back, so a
      // synchronous throw would escape past the caller's `catch` on the promise.
      return Promise.reject(new BridgeClientClosedError())
    }
    if (requests.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new BridgeClientCapExceededError(`over ${BRIDGE_MAX_PENDING_REQUESTS} requests in flight`)
      )
    }
    const [method, params, requestOptions] = args
    const id = nextId()
    return new Promise<RpcResponse>((resolve, reject) => {
      requests.open(id, { resolve, reject })
      const outcome = sendFrame({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'request',
        id,
        method,
        // Absent stays absent, because the shell replays whichever arity crossed. JSON drops an
        // `undefined` value on its own, so an explicit `sendRequest(m, undefined)` reaches the shell
        // as `sendRequest(m)`; no call site passes one, and no wire that carries `undefined` exists
        // to carry it. The spread is what states the intent for a carrier that would.
        ...(args.length > 1 ? { params } : {}),
        ...(requestOptions === undefined ? {} : { options: requestOptions })
      })
      if (outcome !== 'sent') {
        requests.abandon(id)
        // Both are definite failures — the frame never left — and they are told apart because a
        // caller can act on one of them: an oversized request says which action to retry smaller.
        reject(
          outcome === 'oversized' ? new BridgeRequestOversizedError() : new BridgeSendFailedError()
        )
      }
    })
  }

  function subscribe(
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    subscribeOptions?: { onBinaryFrame?: (frame: BrowserScreencastFrame) => void }
  ): () => void {
    requireSession()
    if (closed) {
      return () => undefined
    }
    // Thrown rather than reported: `subscribe` hands back an unsubscribe and nothing else, so a
    // refusal the caller could read does not exist on this member. A refusal the shell posts back
    // arrives too late to throw at all, and reaches the page as a `stream-failed` diagnostic.
    if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new BridgeClientCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`)
    }
    const id = nextId()
    // A frame that never left already told the listener and gave the slot back; the caller still
    // gets a dispose, because it has no way to know which of the two it is holding.
    if (!subscriptions.open(id, method, params, onData, subscribeOptions?.onBinaryFrame)) {
      return () => undefined
    }
    let disposed = false
    return () => {
      if (disposed) {
        return
      }
      disposed = true
      subscriptions.cancel(id)
    }
  }

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    handshake.stop()
    subscriptions.closeAll()
    sendFrame({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
    requests.closeAll()
    cache.close()
    shellSession.close()
    unsubscribeFromMessages()
  }

  const notifications = createBridgeClientNotifications({
    send: posted,
    requireSession,
    isClosed: () => closed,
    hasGrant: (name) => shellSession.current()?.grants.native.includes(name) === true,
    shellAccepts: (name) => shellSession.current()?.accepts.includes(name) === true
  })

  const unsubscribeFromMessages = options.onMessage(receive)
  handshake.start()

  return {
    sendRequest,
    subscribe,
    updateTerminalSubscriptionViewport: notifications.updateTerminalSubscriptionViewport,
    getState: (): ConnectionState => snapshot().state,
    getReconnectAttempt: () => snapshot().reconnectAttempt,
    getLastConnectedAt: () => snapshot().lastConnectedAt,
    getLastInboundAt: () => snapshot().lastInboundAt,
    // A shell client with no generation of its own never migrates, so its epoch is a constant and
    // zero is as true as any other. The page still answers a number, because the member it stands in
    // for is one the native screens read without asking whether it exists.
    getGeneration: () => snapshot().generation ?? 0,
    // Not gated on the session: it registers a listener and reads nothing, so it cannot answer
    // wrongly, and a provider that subscribes before `init` is how a screen hears the first change.
    onStateChange: (listener) => cache.onStateChange(listener),
    notifyForeground: notifications.notifyForeground,
    notifyNavigate: notifications.notifyNavigate,
    notifyNavigateBack: notifications.notifyNavigateBack,
    notifyExternalLink: notifications.notifyExternalLink,
    callNativeVerb: (verb, params) => {
      // Typed to the table, and checked anyway: the type is the fence for every caller the
      // compiler can see, and this is the one for a caller that reached the member through a
      // widened one. Without it the member is a raw port the inventory cannot count, because a
      // bare-identifier call is not a shape its scan looks for.
      if (!isBridgeNativeMethod(verb)) {
        return Promise.reject(new BridgeClientNotNativeVerbError(verb))
      }
      return sendRequest(verb, params).then((reply) => {
        // A refusal crosses as an `error` frame and rejects above, and nothing forwards a native
        // method, so no host `RpcFailure` can arrive on one. Narrowed here rather than at every
        // caller, which is what lets this member promise a success or a rejection and nothing else.
        if (!reply.ok) {
          throw new Error(reply.error.message)
        }
        return reply
      })
    },
    notifyStorageWrite: notifications.notifyStorageWrite,
    notifyHaptics: notifications.notifyHaptics,
    notifyPageFault: notifications.notifyPageFault,
    notifyPagePainted: notifications.notifyPagePainted,
    close,
    onReady: shellSession.onReady,
    onRouteUpdate: shellSession.onRouteUpdate,
    getShellSession: shellSession.current,
    clearRouteParam: (param, value) =>
      shellSession.current()?.accepts.includes(BRIDGE_ROUTE_PARAM_CLEAR) === true &&
      posted({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_ROUTE_PARAM_CLEAR,
        param,
        value
      })
  }
}
