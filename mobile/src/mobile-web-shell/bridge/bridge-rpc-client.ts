import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { RpcClient, SendRequestOptions } from '../../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../../transport/types'
import { BRIDGE_MAX_PENDING_REQUESTS, BRIDGE_MAX_SUBSCRIPTIONS } from './bridge-caps'
import { BridgeConnectionCache } from './bridge-client-connection-cache'
import type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'
import { readShellSession, type BridgeShellSession } from './bridge-client-session'
import { createBridgeInitHandshake } from './bridge-client-init-handshake'
import {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeSendFailedError,
  BridgeShellReplacedError
} from './bridge-client-errors'
import { createBridgeInboundFrameReader } from './bridge-client-inbound-frames'
import { createBridgeClientNotifications } from './bridge-client-notifications'
import { BridgeClientRequests } from './bridge-client-requests'
import { BridgeClientSubscriptions } from './bridge-client-subscriptions'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage
} from './bridge-envelope'

export type { BridgeShellSession } from './bridge-client-session'

export {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeReplyRefusedError,
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
  /** Writes one allowlisted key into the app's store. False when the shell granted no `storage`. */
  notifyStorageWrite: (key: string, value: string | null) => boolean
  /**
   * Tells the shell this page cannot render what it was opened for. Never throws and never rejects:
   * the one caller is an error boundary, and a report that threw would be the second failure.
   *
   * False means nothing left — no session, a closed client, a shell that granted no fault
   * reporting, or a port that refused the frame. There is no second attempt: what could not be said
   * once will not say itself on a retry, and the shell's own load state is the other way it finds out.
   */
  notifyPageFault: (error: unknown) => boolean
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
  const readyListeners = new Set<() => void>()
  let session: BridgeShellSession | null = null
  let closed = false
  let idCounter = 0

  function report(diagnostic: BridgeRpcClientDiagnostic): void {
    options.onDiagnostic?.(diagnostic)
  }

  /** False when the frame never left. Every value in a page frame is one the caller handed in, so
   *  the throw this catches is the port's, never `JSON.stringify`'s. */
  function sendFrame(frame: BridgeClientMessage): boolean {
    try {
      options.send(JSON.stringify(frame))
      return true
    } catch (error) {
      report({ kind: 'send-failed', error })
      return false
    }
  }

  // Counted rather than random: a recorded run replays the same ids, and one page holds one client,
  // so a counter is already unique across everything the shell is asked to keep in flight.
  function nextId(): string {
    idCounter += 1
    return idCounter.toString(36).padStart(BRIDGE_ID_CHARS, '0')
  }

  const subscriptions = new BridgeClientSubscriptions({
    send: (frame) => sendFrame(frame),
    onDroppedBinaryFrame: () => {
      report({ kind: 'binary-frame-dropped' })
    }
  })

  const handshake = createBridgeInitHandshake(() => {
    sendFrame({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' })
  })

  /**
   * A call before `init` is a mount-order bug and throws. A call after `close` is not: an unmounting
   * screen posts one more nudge on its way out, and the native clients answer those inertly rather
   * than throwing into a teardown path nobody wrote a catch for. Each member below says what inert
   * means for its own return type.
   */
  function requireSession(): void {
    if (session === null && !closed) {
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

  /** A second `init` is ordinary: the shell answers every `ready`, and a page that re-asked hears
   *  its own session again. A different id is not, and nothing the page held survives it. */
  function acceptInit(message: Extract<BridgeHostMessage, { type: 'init' }>): void {
    handshake.stop()
    if (session !== null && session.sessionId !== message.sessionId) {
      const replaced = new BridgeShellReplacedError()
      requests.closeAll(replaced)
      subscriptions.failAll(replaced.message)
    }
    session = readShellSession(message)
    cache.prime(message.connection)
    for (const listener of readyListeners) {
      listener()
    }
    readyListeners.clear()
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
    if (!closed) {
      readInboundFrame(json)
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
      const sent = sendFrame({
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
      if (!sent) {
        requests.abandon(id)
        reject(new BridgeSendFailedError())
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
    session = null
    readyListeners.clear()
    unsubscribeFromMessages()
  }

  const notifications = createBridgeClientNotifications({
    send: sendFrame,
    requireSession,
    isClosed: () => closed,
    hasGrant: (name) => session?.grants.native.includes(name) === true
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
    notifyStorageWrite: notifications.notifyStorageWrite,
    notifyPageFault: notifications.notifyPageFault,
    close,
    onReady: (listener) => {
      if (session !== null) {
        listener()
        return () => undefined
      }
      readyListeners.add(listener)
      return () => {
        readyListeners.delete(listener)
      }
    },
    getShellSession: () => session
  }
}
