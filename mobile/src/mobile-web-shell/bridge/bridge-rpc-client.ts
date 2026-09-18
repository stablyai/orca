import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { RpcClient, SendRequestOptions } from '../../transport/rpc-client'
import type { ConnectionState, ForegroundNudgeReason, RpcResponse } from '../../transport/types'
import {
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS,
  utf8ByteLength,
  type BridgeRefusal
} from './bridge-caps'
import { BridgeConnectionCache } from './bridge-client-connection-cache'
import {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeSendFailedError
} from './bridge-client-errors'
import { BridgeClientRequests } from './bridge-client-requests'
import {
  BridgeClientSubscriptions,
  type BridgeStreamEndReason
} from './bridge-client-subscriptions'
import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeHostMessage,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeGrants,
  type BridgeHostMessage
} from './bridge-envelope'
import { reconstructBridgeError } from './bridge-error-capture'

export {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeReplyRefusedError,
  BridgeSendFailedError
} from './bridge-client-errors'

/** Base64url, and the length the envelope's id pattern requires. Base36 digits are a subset of it. */
const BRIDGE_ID_CHARS = 22

/** The page asks again until the shell answers; a session has no other way to start. */
export const BRIDGE_READY_RETRY_MIN_MS = 50
export const BRIDGE_READY_RETRY_MAX_MS = 2000

/** Nothing here is recoverable in place; each is worth a line in a log and none is retried. */
export type BridgeRpcClientDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'send-failed'; error: unknown }
  | { kind: 'stream-ended'; reason: BridgeStreamEndReason }
  | { kind: 'stream-failed'; error: unknown }
  | { kind: 'state-out-of-order' }
  | { kind: 'binary-frame-dropped' }
  | { kind: 'unknown-id' }

/** What `init` said this page is attached to. `grants` is what a call site checks before it posts. */
export type BridgeShellSession = {
  sessionId: string
  buildId: string
  grants: BridgeGrants
}

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
 * that then records the wrong first render, so a call arriving early throws instead.
 */
export function createBridgeRpcClient(options: BridgeRpcClientOptions): BridgeRpcClient {
  const requests = new BridgeClientRequests()
  const cache = new BridgeConnectionCache()
  const readyListeners = new Set<() => void>()
  let session: BridgeShellSession | null = null
  let closed = false
  let idCounter = 0
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let readyDelayMs = BRIDGE_READY_RETRY_MIN_MS

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
    send: (frame) => {
      sendFrame(frame)
    },
    onDroppedBinaryFrame: () => {
      report({ kind: 'binary-frame-dropped' })
    }
  })

  function askForInit(): void {
    sendFrame({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' })
    readyTimer = setTimeout(() => {
      readyDelayMs = Math.min(readyDelayMs * 2, BRIDGE_READY_RETRY_MAX_MS)
      askForInit()
    }, readyDelayMs)
  }

  function stopAskingForInit(): void {
    if (readyTimer !== null) {
      clearTimeout(readyTimer)
      readyTimer = null
    }
  }

  function requireSession(): void {
    if (closed) {
      throw new BridgeClientClosedError()
    }
    if (session === null) {
      throw new BridgeClientNotReadyError()
    }
  }

  function snapshot(): BridgeConnectionSnapshot {
    const held = cache.read()
    if (closed) {
      throw new BridgeClientClosedError()
    }
    if (held === null) {
      throw new BridgeClientNotReadyError()
    }
    return held
  }

  function acceptInit(message: Extract<BridgeHostMessage, { type: 'init' }>): void {
    stopAskingForInit()
    session = { sessionId: message.sessionId, buildId: message.buildId, grants: message.grants }
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
    stopAskingForInit()
    readyDelayMs = BRIDGE_READY_RETRY_MIN_MS
    askForInit()
  }

  /** The shell answers a refused `subscribe` with `error` on the stream's id. Nothing is pending to
   *  reject there, so routing it to the requests would drop it and hold the page's slot forever. */
  function failExchange(id: string, error: unknown): void {
    if (subscriptions.has(id)) {
      subscriptions.end(id)
      report({ kind: 'stream-failed', error })
      return
    }
    if (!requests.has(id)) {
      report({ kind: 'unknown-id' })
    }
    // Still routed: an id with a half-assembled reply behind it holds a slot until it is discarded.
    requests.fail(id, error)
  }

  function dispatch(message: BridgeHostMessage, json: string): void {
    switch (message.type) {
      case 'init':
        acceptInit(message)
        return
      case 'state':
        acceptState(message.connection)
        return
      case 'reply':
        if (!requests.has(message.id)) {
          report({ kind: 'unknown-id' })
        }
        requests.acceptReply(message)
        return
      case 'error':
        failExchange(message.id, reconstructBridgeError(message.error))
        return
      case 'event':
        subscriptions.deliver(message, utf8ByteLength(json))
        return
      case 'end':
        subscriptions.end(message.id)
        report({ kind: 'stream-ended', reason: message.reason })
        return
    }
  }

  function receive(json: string): void {
    if (closed) {
      return
    }
    const read = readBridgeHostMessage(json)
    if (!read.ok) {
      report({ kind: 'refused', refusal: read.refusal })
      return
    }
    dispatch(read.message, json)
  }

  function sendRequest(...args: [string, unknown?, SendRequestOptions?]): Promise<RpcResponse> {
    // A call with no session is a page bug and throws; a call over the in-flight cap is the answer
    // the shell would have posted back, so it arrives the way the shell's does, as a rejection.
    requireSession()
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
    // Thrown rather than reported: `subscribe` hands back an unsubscribe and nothing else, so a
    // refusal the caller could read does not exist on this member. A refusal the shell posts back
    // arrives too late to throw at all, and reaches the page as a `stream-failed` diagnostic.
    if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new BridgeClientCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`)
    }
    const id = nextId()
    subscriptions.open(id, method, params, onData, subscribeOptions?.onBinaryFrame)
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
    stopAskingForInit()
    subscriptions.closeAll()
    sendFrame({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
    requests.closeAll()
    cache.clear()
    session = null
    readyListeners.clear()
    unsubscribeFromMessages()
  }

  const unsubscribeFromMessages = options.onMessage(receive)
  askForInit()

  return {
    sendRequest,
    subscribe,
    updateTerminalSubscriptionViewport: (terminal, viewport) => {
      requireSession()
      sendFrame({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'terminalViewport',
        terminal,
        cols: viewport.cols,
        rows: viewport.rows
      })
    },
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
    notifyForeground: (reason?: ForegroundNudgeReason) => {
      requireSession()
      sendFrame({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'foreground',
        ...(reason === undefined ? {} : { reason })
      })
    },
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
