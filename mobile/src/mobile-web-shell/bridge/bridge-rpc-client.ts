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
import { createBridgeInitHandshake, createPageReadyFrame } from './bridge-client-init-handshake'
import {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeRequestOversizedError,
  BridgeSendFailedError,
  BridgeShellReplacedError
} from './bridge-client-errors'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import { createBridgeInboundFrameReader } from './bridge-client-inbound-frames'
import { createBridgeClientNotifications } from './bridge-client-notifications'
import type { BridgeSafeAreaInsets } from './bridge-safe-area-insets'
import { createPageBackConsumers, type PageBackConsumer } from './page-back-consumers'
import { BridgeClientRequests } from './bridge-client-requests'
import { readBridgeRequestFrameOptions, readBridgeRpcEnvelope } from './bridge-client-rpc-envelope'
import { BridgeClientSubscriptions } from './bridge-client-subscriptions'
import type { BridgeNativeVerb } from './bridge-native-verbs'
import { callBridgeNativeVerb } from './bridge-native-verb-call'
import { BRIDGE_ROUTE_PARAM_CLEAR, type BridgeClearableRouteParam } from './bridge-route-update'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_ENVELOPE_GRANT,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeInitRoute
} from './bridge-envelope'

export type { BridgeShellSession } from './bridge-client-session'

export {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  BridgeReplyRefusedError,
  BridgeRequestOversizedError,
  BridgeRpcEnvelopeInvalidError,
  BridgeRpcEnvelopeUngrantedError,
  BridgeSendFailedError,
  BridgeShellReplacedError
} from './bridge-client-errors'

const BRIDGE_ID_CHARS = 22

export type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'

export type BridgeRpcClientOptions = {
  send: (json: string) => void
  onMessage: (handler: (json: string) => void) => () => void
  onDiagnostic?: (diagnostic: BridgeRpcClientDiagnostic) => void
}

export type BridgeRpcClient = RpcClient & {
  onReady: (listener: () => void) => () => void
  // Publish changed params only, never initial/repeated init. Clear consumed one-shot params so repeat taps to the same pane still appear as real changes.
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  onSafeAreaInsetsUpdate: (listener: (insets: BridgeSafeAreaInsets) => void) => () => void
  onKeyboardInsetUpdate: (listener: (height: number) => void) => () => void
  onColorSchemeUpdate: (listener: (scheme: BridgeShellSession['colorScheme']) => void) => () => void
  getShellSession: () => BridgeShellSession | null
  // False without navigate lets tap handlers fall back safely instead of throwing into uncaught UI callbacks.
  notifyNavigate: (href: string, replace?: boolean) => boolean
  // The page owns no native history; ask the shell to pop. Missing grant returns false; older shells may also drop the new notify, so callers retain their router fallback.
  notifyNavigateBack: () => boolean
  // False means missing externalLink grant or refused URL; callers must offer another outcome for the tap.
  notifyExternalLink: (url: string) => boolean
  // Use the existing request/id/cap lane but keep native methods inside the bridge’s typed surface; they are device verbs, not catalogued desktop RPCs.
  callNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<RpcSuccess>
  // Only the page can report a painted tree; WebView commit and ready happen before that proof exists.
  notifyPagePainted: () => void
  // Older shells refuse the frame with a diagnostic only; they reopen the host route after a fold.
  notifyPageLocation: (href: string) => void
  // Claim Back until disposal; invoke consumers newest-first with false fallthrough. Return unhandled presses to the shell so a race with sheet closure cannot swallow navigation.
  claimBack: (consumer: PageBackConsumer) => () => void
  notifyStorageWrite: (key: string, value: string | null) => boolean
  notifyHaptics: (kind: BridgeHapticsKind) => boolean
  // Never throw from error-boundary reporting. False means no frame left; shell load recovery covers reports that cannot be sent, without retrying this fault.
  notifyPageFault: (error: unknown) => boolean
  // After applying a one-shot param, ask its holder to clear that value (ruling 34). A failed clear is repaired when init delivers the still-held request again.
  clearRouteParam: (param: BridgeClearableRouteParam, value: string) => boolean
}

// Expose synchronous RpcClient getters from init-primed state so first renders match native clients. Page close settles its own work, never the native client shared by other screens.
// Ungated calls before init throw for mount-order bugs; after close, teardown calls are inert and getters retain a disconnected snapshot. Stream failures notify listeners.
export function createBridgeRpcClient(options: BridgeRpcClientOptions): BridgeRpcClient {
  const requests = new BridgeClientRequests()
  const cache = new BridgeConnectionCache()
  let closed = false
  let idCounter = 0

  function report(diagnostic: BridgeRpcClientDiagnostic): void {
    options.onDiagnostic?.(diagnostic)
  }

  // Never throw: serialization/transport failure must return control to request-id cleanup. Keep JSON.stringify inside try for cycles, BigInt and throwing toJSON.
  // Refuse oversize using the shell’s exact predicate before posting, or the receiver drops it and leaves the caller waiting forever.
  function sendFrame(frame: BridgeClientMessage): 'sent' | 'oversized' | 'port-failed' {
    try {
      const json = JSON.stringify(frame)
      if (!isBridgeFrameWithinCap(json)) {
        // Count UTF-8 bytes like Swift utf8.count and Kotlin UTF_8 size; JS code units undercount non-ASCII requests.
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

  const hasGrant = (name: string) => shellSession.current()?.grants.native.includes(name) === true

  const posted = (frame: BridgeClientMessage): boolean => sendFrame(frame) === 'sent'

  // Use a deterministic counter for recorded replay; one page/client makes it unique across active exchanges.
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
    sendFrame(createPageReadyFrame())
  })

  // Before-init calls expose mount-order bugs; after-close calls stay inert because teardown callers generally have no catch.
  function requireSession(): void {
    if (shellSession.current() === null && !closed) {
      throw new BridgeClientNotReadyError()
    }
  }

  function snapshot(): BridgeConnectionSnapshot {
    const held = cache.read()
    if (held === null) {
      throw new BridgeClientNotReadyError()
    }
    return held
  }

  // Repeated init for the same session updates route/insets/cache while preserving exchanges and the original storage snapshot. A different session id invalidates prior work.
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

  function acceptState(snapshotFromShell: BridgeConnectionSnapshot): void {
    if (cache.apply(snapshotFromShell) !== 'stale') {
      return
    }
    report({ kind: 'state-out-of-order' })
    handshake.restart()
  }

  const back = createPageBackConsumers({
    publishClaim: (claimed) => notifications.notifyBackClaim(claimed),
    onUnclaimed: () => {
      report({ kind: 'back-unclaimed' })
      notifications.notifyNavigateBack()
    }
  })

  const readInboundFrame = createBridgeInboundFrameReader({
    requests,
    subscriptions,
    report,
    // Reassert only after the new init has been applied to the session.
    acceptInit: (message) => {
      handshake.stop()
      shellSession.accept(message)
      back.reassert()
    },
    acceptState,
    acceptBack: back.press
  })

  function receive(json: string): void {
    if (closed) {
      return
    }
    try {
      readInboundFrame(json)
    } catch (error) {
      // Catch listener failures after frame receipt; letting them escape would reject iOS native post for a delivered frame. Report without retrying (ruling 34 addendum).
      report({ kind: 'inbound-listener-threw', error })
    }
  }

  function sendRequest(...args: [string, unknown?, SendRequestOptions?]): Promise<RpcResponse> {
    // Missing session is a synchronous mount-order bug; in-flight cap refusal instead rejects like the shell’s response.
    requireSession()
    if (closed) {
      // Return a rejected promise: deferred operations hand it back directly, so synchronous throws would bypass callers’ promise catches.
      return Promise.reject(new BridgeClientClosedError())
    }
    if (requests.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new BridgeClientCapExceededError(`over ${BRIDGE_MAX_PENDING_REQUESTS} requests in flight`)
      )
    }
    const [method, params, requestOptions] = args
    return new Promise<RpcResponse>((resolve, reject) => {
      const frameOptions = readBridgeRequestFrameOptions(requestOptions, hasGrant)
      const id = nextId()
      requests.open(id, { resolve, reject })
      const outcome = sendFrame({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'request',
        id,
        method,
        // Preserve absent params for replayed arity. JSON cannot carry explicit undefined, so that spelling necessarily arrives as the absent form.
        ...(args.length > 1 ? { params } : {}),
        ...frameOptions
      })
      if (outcome !== 'sent') {
        requests.abandon(id)
        // Both failures prove nothing was sent; distinguish oversize so the caller can retry a smaller action.
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
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    requireSession()
    if (closed) {
      return () => undefined
    }
    // Subscribe returns only cleanup, so local refusal throws; asynchronous shell refusal instead reports through the stream diagnostic.
    if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new BridgeClientCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`)
    }
    const { onBinaryFrame, envelope: fields } = subscribeOptions ?? {}
    const envelope = readBridgeRpcEnvelope(fields, hasGrant)
    const id = nextId()
    // Failed posting already freed the slot and notified its listener; still return an idempotent cleanup.
    if (!subscriptions.open(id, method, params, onData, onBinaryFrame, envelope)) {
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
    back.clear()
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
    hasGrant
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
    // Clients without migration generation use a constant zero; native screen readers still require a number.
    getGeneration: () => snapshot().generation ?? 0,
    carriesRpcEnvelope: () => hasGrant(BRIDGE_RPC_ENVELOPE_GRANT),
    // Allow listener registration before init so providers can observe the first state change; it reads no unprimed value.
    onStateChange: (listener) => cache.onStateChange(listener),
    notifyForeground: notifications.notifyForeground,
    notifyNavigate: notifications.notifyNavigate,
    notifyNavigateBack: notifications.notifyNavigateBack,
    notifyExternalLink: notifications.notifyExternalLink,
    callNativeVerb: (verb, params) => callBridgeNativeVerb(sendRequest, verb, params),
    notifyStorageWrite: notifications.notifyStorageWrite,
    notifyHaptics: notifications.notifyHaptics,
    notifyPageFault: notifications.notifyPageFault,
    notifyPagePainted: notifications.notifyPagePainted,
    notifyPageLocation: notifications.notifyPageLocation,
    claimBack: back.claim,
    close,
    onReady: shellSession.onReady,
    onRouteUpdate: shellSession.onRouteUpdate,
    onSafeAreaInsetsUpdate: shellSession.onSafeAreaInsetsUpdate,
    onKeyboardInsetUpdate: shellSession.onKeyboardInsetUpdate,
    onColorSchemeUpdate: shellSession.onColorSchemeUpdate,
    getShellSession: shellSession.current,
    clearRouteParam: (param, value) =>
      posted({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_ROUTE_PARAM_CLEAR,
        param,
        value
      })
  }
}
