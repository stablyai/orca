import { useCallback, useLayoutEffect, useRef } from 'react'
import type {
  MobileWebShellBridgeMessagePayload,
  OrcaMobileWebShellViewHandle
} from '../../modules/orca-mobile-web-shell/src'
import { useHostClient } from '../transport/client-context'
import { createBridgeDiagnosticReporter } from './bridge-diagnostic-log'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import { createBridgeHost, type BridgeHost } from './bridge-host'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { PageHostSnapshot } from './use-page-host-snapshot'
import type { PageStorageForInit } from './page-storage-keys'

class BridgeViewGoneError extends Error {
  constructor() {
    super('the shell view for this session is not mounted')
    this.name = 'BridgeViewGoneError'
  }
}

/**
 * Both halves are stamped with the session they belong to.
 *
 * React swaps refs in the commit phase and runs the retiring effect's cleanup after it, so a host
 * disposing on a remount would otherwise post its teardown frames into the page that replaced it.
 */
type MountedView = { sessionId: string; handle: OrcaMobileWebShellViewHandle }
type MountedHost = { sessionId: string; host: BridgeHost }

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
  /** The route patterns the page keeps for itself; everything else comes back as `navigate`. */
  pageRoutes: readonly string[]
  pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  /** What this route declared, which is what `init` grants and what every grant check reads. */
  routeGrants: readonly string[]
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
  const viewRef = useRef<MountedView | null>(null)
  const hostRef = useRef<MountedHost | null>(null)
  /**
   * Every prop, held rather than depended on: the host is built once per session, and a caller's
   * fresh closures and inline objects every render must not tear one down and settle its pendings.
   *
   * The route in it is not the whole story any more (ruling 33.1). A same-path param change used
   * to be unreachable — the page routes once, before its first render, so a route that changed
   * afterwards had nothing left to change, and every switch keyed on the whole route to make one
   * a remount. The session switch does not: a notification tap for another pane of the session on
   * screen is a tab switch, so it keeps `paneKey` out of its key and hands the change to
   * `publishRoute` below, which re-sends `init` to a page that said it takes one.
   */
  const argsRef = useRef(args)
  // Held rather than depended on, for the reason every prop above is: the identity settles with the
  // client, and taking it as a dependency would tear a live page session down to re-read a string.
  const clientIdRef = useRef(clientId)
  // Commit-phase and declared above the host's effect, so the host is built against what this
  // render passed: a native frame can land between a commit and a passive effect.
  //
  // No dependency list, rather than one holding `args`: a caller builds that object inline, so
  // every render is a new one and there is nothing to compare. This runs after each commit, which
  // is what the ref is for.
  useLayoutEffect(() => {
    argsRef.current = args
    clientIdRef.current = clientId
  })
  const snapshot = args.snapshot

  // Commit-phase, not passive: a native frame that arrives between the two carries the session id
  // the handler is fenced on, so only handing the host over here keeps it off the retired client.
  useLayoutEffect(() => {
    if (client === null || sessionId === null || buildId === null || snapshot === null) {
      return
    }
    const latest = argsRef.current
    // The host outlives every render after this one, so each callback it holds reads the ref at
    // call time: a closure captured here would settle frames into a screen that has moved on, and
    // adding one is an entry in `MobileWebShellBridgeArgs` and a line here, nothing else.
    const host = createBridgeHost({
      client,
      buildId,
      sessionId,
      route: latest.route,
      pageRoutes: latest.pageRoutes,
      pageRouteGrants: latest.pageRouteGrants,
      routeGrants: latest.routeGrants,
      sessionEstablished: latest.sessionEstablished,
      host: snapshot.host,
      readClientIdentity: () => clientIdRef.current,
      post: (json) => {
        const mounted = viewRef.current
        return mounted === null || mounted.sessionId !== sessionId
          ? Promise.reject(new BridgeViewGoneError())
          : mounted.handle.postBridgeMessage(json)
      },
      onDiagnostic: createBridgeDiagnosticReporter(),
      onNavigate: (href) => argsRef.current.onNavigate(href),
      onNavigateBack: () => argsRef.current.onNavigateBack(),
      onExternalLink: (url) => argsRef.current.onExternalLink(url),
      onHaptic: (kind) => argsRef.current.onHaptic(kind),
      serveNativeVerb: (verb, params) => argsRef.current.serveNativeVerb(verb, params),
      readStorage: () => argsRef.current.readStorage(),
      onStorageWrite: (key, value) => argsRef.current.onStorageWrite(key, value),
      onPageFault: (error) => argsRef.current.onPageFault(error),
      onRouteParamClear: (param, value) => argsRef.current.onRouteParamClear(param, value),
      onRouteRefused: (issue) => argsRef.current.onRouteRefused(issue),
      onBinaryFramesDropped: (total) => argsRef.current.onBinaryFramesDropped(total),
      onPageReady: () => argsRef.current.onPageReady()
    })
    hostRef.current = { sessionId, host }
    // The count belongs to this host, so a rebuild starts it over. Without this the screen keeps
    // the retired host's number and the next drop reports the new host's first, so the line falls —
    // which reads as frames coming back rather than as a fresh count.
    latest.onBinaryFramesDropped(0)
    return () => {
      hostRef.current = null
      host.dispose()
    }
  }, [buildId, client, sessionId, snapshot])

  return {
    bridgeEnabled: ready !== null,
    viewRef: useCallback(
      (handle: OrcaMobileWebShellViewHandle | null) => {
        viewRef.current = handle === null || sessionId === null ? null : { sessionId, handle }
      },
      [sessionId]
    ),
    onBridgeMessage: useCallback(
      (event: MobileWebShellBridgeMessageEvent) => {
        const mounted = hostRef.current
        if (mounted === null || mounted.sessionId !== sessionId) {
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
      [buildId, client, sessionId, snapshot]
    )
  }
}
