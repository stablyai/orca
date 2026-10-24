import { useCallback, useLayoutEffect, useRef } from 'react'
import type {
  MobileWebShellBridgeMessagePayload,
  OrcaMobileWebShellViewHandle
} from '../../modules/orca-mobile-web-shell/src'
import { useHostClient } from '../transport/host-client-hooks'
import { frameWithoutHostLine } from './shell-bridge-log-lines'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import type { BridgeHost } from './bridge-host'
import type { BridgeSessionBack } from './bridge-host-back'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { PageHostSnapshot } from './use-page-host-snapshot'
import type { PageStorageForInit } from './page-storage-keys'
import {
  acquireRetainedOrCreateBridgeHost,
  postToMountedBridgeView,
  releaseOrParkBridgeHost,
  resetBridgeDocumentBindings,
  type MountedBridgeView
} from './retained-bridge-host-lifecycle'
import {
  flushRetainedBridgeFrames,
  type RetainedBridgeHostBinding
} from './retained-shell-session-store'

type MountedHost = { sessionId: string; host: BridgeHost }
type EstablishedBack = { sessionId: string; back: BridgeSessionBack }

/** Exactly the field the handler reads. The view's own `NativeSyntheticEvent` prop type is
 *  assignable to this, and a handler declared this narrowly is one a test can call honestly. */
export type MobileWebShellBridgeMessageEvent = {
  readonly nativeEvent: MobileWebShellBridgeMessagePayload
}

export type MobileWebShellBridgeView = {
  /**
   * Changing this prop re-enters the native load, so it is derived from the session step alone and
   * is constant for the life of a mount. A ready session whose client has not arrived yet gets the
   * channel and no host: there is no honest `init` to answer with, and `ready` is answered every
   * time it is asked so the page can ask again.
   */
  readonly bridgeEnabled: boolean
  readonly viewRef: (handle: OrcaMobileWebShellViewHandle | null) => void
  readonly onBridgeMessage: (event: MobileWebShellBridgeMessageEvent) => void
  /**
   * Hands the mounted host a rewritten route for the screen it is already serving. Dropped when
   * there is no host yet; the route the host is built from carries it instead.
   */
  readonly publishRoute: (route: BridgeInitRoute) => void
  /** Hands the mounted host moved safe-area insets; dropped with no host, as a route is. */
  readonly publishSafeAreaInsets: (insets: BridgeSafeAreaInsets) => void
  /** Hands the mounted host a moved keyboard height; dropped with no host, as the insets are. */
  readonly publishKeyboardInset: (height: number) => void
  /**
   * Hands the mounted host one Back press. False when there is no host, or when the document it
   * serves never said it takes one — the caller then leaves the key to the navigator.
   */
  readonly sendBack: () => boolean
}

/** Everything one render of the screen hands the bridge. Named rather than inline because the host
 *  is built against the whole object, read back through one ref. */
export type MobileWebShellBridgeArgs = {
  hostId: string
  session: MobileWebShellSessionState
  /**
   * Whether this session has already handshaken, as the reducer that owns it records it.
   *
   * A host is rebuilt when the client under it changes and the page is never told: the session id
   * does not move, so it neither handshakes again nor hears that the shell was replaced. The fact
   * is about the session rather than this mount, so it arrives with the render.
   */
  sessionEstablished: boolean
  /** The screen the page is standing in for, which the document's own `/` cannot tell it. */
  route: BridgeInitRoute
  /** What the first `init` of a new host carries; later moves go through `publishSafeAreaInsets`. */
  safeAreaInsets: BridgeSafeAreaInsets
  /** What the first `init` of a new host carries; later moves go through `publishKeyboardInset`. */
  keyboardInset: number
  /** The route patterns the page keeps for itself; everything else comes back as `navigate`. */
  pageRoutes: readonly string[]
  pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  /** What this route declared, which is what `init` grants and what every grant check reads. */
  routeGrants: readonly string[]
  /** This session owns the whole host area, which `init` tells the page. */
  ownsHostArea?: boolean
  /** Opens a screen the page does not render, over the still-mounted view. */
  onNavigate: (href: string) => void
  /** Opens a URL outside the app, on the page's behalf. */
  onExternalLink: (url: string) => void
  /** Plays one haptic on this device, on the page's behalf. */
  onHaptic: (kind: BridgeHapticsKind) => void
  /** Serves one `native.` verb on this device, for a page that was granted it. */
  serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  /** Pops the stack this page was pushed onto, and says so when it did not. */
  onNavigateBack: () => BridgeNavigateBackOutcome
  /**
   * This host and its stored keys, or null while they are being read. No host is built without
   * them: `init` is answered once per `ready` and carries both, so a host that started without
   * them would have to be torn down to carry them, and the page would have mounted its list
   * against a host it could not name.
   */
  snapshot: PageHostSnapshot | null
  /** The allowlisted keys as the app holds them, asked for on each `init` rather than at mount. */
  readStorage: () => PageStorageForInit
  onStorageWrite: (key: string, value: string | null) => void
  /** The page could not render the generation on screen. Reported, never recovered from here. */
  onPageFault: (error: BridgeErrorCapture) => void
  /** The page asked for a session. Reported so the screen can stop waiting for it. */
  onPageReady: () => void
  /** The page has a frame on screen. */
  onPagePainted: () => void
  /** The page is holding the device Back key, or has let it go. False arrives on its own for
   *  every way a document ends, so no claim outlives the page that made it. */
  onPageBackClaim: (claimed: boolean) => void
  /** The page applied a one-shot route param and asks for it to be erased (ruling 34). */
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  /** This shell named a screen the protocol does not allow, so no session is served. */
  onRouteRefused: (issue: string) => void
  /** Every screencast frame this host has dropped, so the shell can show the running total. */
  onBinaryFramesDropped: (total: number) => void
}

/**
 * Wires B4's session to one bridge host: the session the reducer put on screen owns the channel,
 * and nothing here mints, retries or decides anything.
 *
 * The session id is B4's — a remount is a new one, which is what makes a dead page's frames fail
 * the native origin check rather than reach a live client.
 */
export function useMobileWebShellBridge(args: MobileWebShellBridgeArgs): MobileWebShellBridgeView {
  const { client, clientId } = useHostClient(args.hostId)
  const ready = args.session.kind === 'ready' ? args.session : null
  const sessionId = ready?.sessionId ?? null
  const buildId = ready?.buildId ?? null
  const viewRef = useRef<MountedBridgeView | null>(null)
  const hostRef = useRef<MountedHost | null>(null)
  const bindingRef = useRef<RetainedBridgeHostBinding | null>(null)
  const establishedBackRef = useRef<EstablishedBack | null>(null)
  const argsRef = useRef(args)
  const clientIdRef = useRef(clientId)
  const clientRef = useRef(client)
  const droppedFrameLoggedRef = useRef<string | null>(null)
  const writingFromPageRef = useRef(false)
  useLayoutEffect(() => {
    argsRef.current = args
    clientIdRef.current = clientId
    clientRef.current = client
    if (bindingRef.current !== null) {
      bindingRef.current.args = args
      bindingRef.current.clientId = clientId
    }
  })
  const hasSnapshot = args.snapshot !== null

  useLayoutEffect(() => {
    const currentSnapshot = argsRef.current.snapshot
    if (client === null || sessionId === null || buildId === null || currentSnapshot === null) {
      return
    }
    const { host, binding } = acquireRetainedOrCreateBridgeHost({
      client,
      buildId,
      sessionId,
      snapshot: currentSnapshot,
      latest: argsRef.current,
      clientId: clientIdRef.current,
      sessionBack:
        establishedBackRef.current?.sessionId === sessionId
          ? establishedBackRef.current.back
          : undefined,
      readMountedView: () => viewRef.current,
      setWritingFromPage: (writing) => {
        writingFromPageRef.current = writing
      }
    })
    bindingRef.current = binding
    hostRef.current = { sessionId, host }
    return () => {
      establishedBackRef.current = { sessionId, back: host.readSessionBack() }
      hostRef.current = null
      if (bindingRef.current === binding) {
        bindingRef.current = null
      }
      releaseOrParkBridgeHost({
        hostId: argsRef.current.hostId,
        sessionId,
        buildId,
        client,
        host,
        binding
      })
    }
  }, [buildId, client, hasSnapshot, sessionId])

  const wasEstablishedRef = useRef<{ sessionId: string | null; established: boolean }>({
    sessionId,
    established: args.sessionEstablished
  })
  useLayoutEffect(() => {
    const previous = wasEstablishedRef.current
    wasEstablishedRef.current = { sessionId, established: args.sessionEstablished }
    if (previous.sessionId === sessionId && previous.established && !args.sessionEstablished) {
      establishedBackRef.current = null
      resetBridgeDocumentBindings(
        bindingRef.current,
        hostRef.current?.sessionId === sessionId ? hostRef.current.host : null
      )
    }
  }, [args.sessionEstablished, sessionId])


  return {
    bridgeEnabled: ready !== null,
    viewRef: useCallback(
      (handle: OrcaMobileWebShellViewHandle | null) => {
        viewRef.current = handle === null || sessionId === null ? null : { sessionId, handle }
        if (handle === null || sessionId === null) {
          if (bindingRef.current !== null) {
            bindingRef.current.post = null
          }
          return
        }
        if (bindingRef.current !== null) {
          flushRetainedBridgeFrames(bindingRef.current, (json) =>
            postToMountedBridgeView(viewRef.current, sessionId, json)
          )
        }
      },
      [sessionId]
    ),
    onBridgeMessage: useCallback(
      (event: MobileWebShellBridgeMessageEvent) => {
        const mounted = hostRef.current
        if (mounted === null || mounted.sessionId !== sessionId) {
          if (
            mounted === null &&
            sessionId !== null &&
            droppedFrameLoggedRef.current !== sessionId
          ) {
            droppedFrameLoggedRef.current = sessionId
            recordShellLifecycleLine(
              argsRef.current.hostId,
              frameWithoutHostLine({
                clientReady: clientRef.current !== null,
                snapshotReady: argsRef.current.snapshot !== null
              })
            )
          }
          return
        }
        mounted.host.receive(event.nativeEvent.json)
      },
      [sessionId]
    ),
    // Fenced on the session the same way inbound frames are: a host left over from a session this
    // render has moved past must not be handed this one's route.
    //
    // Keyed on everything the host is built from, not on the session alone: a caller that holds a
    // route the host was not there to take retries when this identity changes, and the host's own
    // effect is a layout effect, so by the time a passive effect sees the new identity the host
    // behind it exists.
    publishRoute: useCallback(
      (route: BridgeInitRoute) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishRoute(route)
        }
      },
      [buildId, client, hasSnapshot, sessionId]
    ),
    publishSafeAreaInsets: useCallback(
      (insets: BridgeSafeAreaInsets) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishSafeAreaInsets(insets)
        }
      },
      [buildId, client, hasSnapshot, sessionId]
    ),
    publishKeyboardInset: useCallback(
      (height: number) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishKeyboardInset(height)
        }
      },
      [buildId, client, hasSnapshot, sessionId]
    ),
    // Fenced on the session the way inbound frames are, and answering false rather than throwing
    // when there is no host: the caller is a hardware key handler, and a press it cannot forward
    // is one the navigator has to be left to answer.
    sendBack: useCallback(() => {
      const mounted = hostRef.current
      return mounted !== null && mounted.sessionId === sessionId && mounted.host.sendBack()
    }, [sessionId])
  }
}

