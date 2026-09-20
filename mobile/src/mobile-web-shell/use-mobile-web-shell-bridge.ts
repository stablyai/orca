import { useCallback, useLayoutEffect, useRef } from 'react'
import type {
  MobileWebShellBridgeMessagePayload,
  OrcaMobileWebShellViewHandle
} from '../../modules/orca-mobile-web-shell/src'
import { useHostClient } from '../transport/client-context'
import { createBridgeDiagnosticReporter } from './bridge-diagnostic-log'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import { createBridgeHost, type BridgeHost } from './bridge-host'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { PageHostSnapshot } from './use-page-host-snapshot'

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
}

/**
 * Wires B4's session to one bridge host: the session the reducer put on screen owns the channel,
 * and nothing here mints, retries or decides anything.
 *
 * The session id is B4's — a remount is a new one, which is what makes a dead page's frames fail
 * the native origin check rather than reach a live client.
 */
export function useMobileWebShellBridge(args: {
  hostId: string
  session: MobileWebShellSessionState
  /** The screen the page is standing in for, which the document's own `/` cannot tell it. */
  route: BridgeInitRoute
  /** The route patterns the page keeps for itself; everything else comes back as `navigate`. */
  pageRoutes: readonly string[]
  /** What this route declared, which is what `init` grants and what every grant check reads. */
  routeGrants: readonly string[]
  /** Opens a screen the page does not render, over the still-mounted view. */
  onNavigate: (href: string) => void
  /** Opens a URL outside the app, on the page's behalf. */
  onExternalLink: (url: string) => void
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
  readStorage: () => Readonly<Record<string, string>>
  onStorageWrite: (key: string, value: string | null) => void
  /** The page could not render the generation on screen. Reported, never recovered from here. */
  onPageFault: (error: BridgeErrorCapture) => void
  /** The page asked for a session. Reported so the screen can stop waiting for it. */
  onPageReady: () => void
  /** This shell named a screen the protocol does not allow, so no session is served. */
  onRouteRefused: (issue: string) => void
  /** Every screencast frame this host has dropped, so the shell can show the running total. */
  onBinaryFramesDropped: (total: number) => void
}): MobileWebShellBridgeView {
  const { client } = useHostClient(args.hostId)
  const ready = args.session.kind === 'ready' ? args.session : null
  const sessionId = ready?.sessionId ?? null
  const buildId = ready?.buildId ?? null
  const viewRef = useRef<MountedView | null>(null)
  const hostRef = useRef<MountedHost | null>(null)
  // Fixed for the life of one host: the page routes once, before its first render, so a route that
  // changed afterwards would have nothing left to change. Held in a ref for that reason — an inline
  // object in the deps would rebuild the host on every render and settle its pendings each time.
  const routeRef = useRef(args.route)
  const pageRoutesRef = useRef(args.pageRoutes)
  const routeGrantsRef = useRef(args.routeGrants)
  /** The session that has completed a handshake, so a host rebuilt for it inherits that. */
  const establishedSessionRef = useRef<string | null>(null)
  // Read through a ref for the same reason: the host is built once per session, and a caller's
  // fresh closure every render must not tear one down and settle its pendings.
  const navigateRef = useRef(args.onNavigate)
  const externalLinkRef = useRef(args.onExternalLink)
  const nativeVerbRef = useRef(args.serveNativeVerb)
  const navigateBackRef = useRef(args.onNavigateBack)
  const storageWriteRef = useRef(args.onStorageWrite)
  const readStorageRef = useRef(args.readStorage)
  const pageFaultRef = useRef(args.onPageFault)
  const pageReadyRef = useRef(args.onPageReady)
  const routeRefusedRef = useRef(args.onRouteRefused)
  const binaryFramesDroppedRef = useRef(args.onBinaryFramesDropped)
  // Commit-phase and declared above the host's effect, so the host is built against what this
  // render passed: a native frame can land between a commit and a passive effect.
  useLayoutEffect(() => {
    routeRef.current = args.route
    pageRoutesRef.current = args.pageRoutes
    routeGrantsRef.current = args.routeGrants
    navigateRef.current = args.onNavigate
    externalLinkRef.current = args.onExternalLink
    nativeVerbRef.current = args.serveNativeVerb
    navigateBackRef.current = args.onNavigateBack
    storageWriteRef.current = args.onStorageWrite
    readStorageRef.current = args.readStorage
    pageFaultRef.current = args.onPageFault
    pageReadyRef.current = args.onPageReady
    routeRefusedRef.current = args.onRouteRefused
    binaryFramesDroppedRef.current = args.onBinaryFramesDropped
  }, [
    args.onBinaryFramesDropped,
    args.onExternalLink,
    args.serveNativeVerb,
    args.onNavigate,
    args.onNavigateBack,
    args.onPageFault,
    args.onPageReady,
    args.onRouteRefused,
    args.onStorageWrite,
    args.readStorage,
    args.pageRoutes,
    args.routeGrants,
    args.route
  ])
  const snapshot = args.snapshot

  // Commit-phase, not passive: a native frame that arrives between the two carries the session id
  // the handler is fenced on, so only handing the host over here keeps it off the retired client.
  useLayoutEffect(() => {
    if (client === null || sessionId === null || buildId === null || snapshot === null) {
      return
    }
    const host = createBridgeHost({
      client,
      buildId,
      sessionId,
      route: routeRef.current,
      pageRoutes: pageRoutesRef.current,
      routeGrants: routeGrantsRef.current,
      sessionEstablished: establishedSessionRef.current === sessionId,
      onPageFault: (error) => {
        pageFaultRef.current(error)
      },
      onPageReady: () => {
        establishedSessionRef.current = sessionId
        pageReadyRef.current()
      },
      onRouteRefused: (issue) => {
        routeRefusedRef.current(issue)
      },
      onBinaryFramesDropped: (total) => {
        binaryFramesDroppedRef.current(total)
      },
      onNavigate: (href) => {
        navigateRef.current(href)
      },
      onNavigateBack: () => navigateBackRef.current(),
      onExternalLink: (url) => {
        externalLinkRef.current(url)
      },
      serveNativeVerb: (verb, params) => nativeVerbRef.current(verb, params),
      host: snapshot.host,
      readStorage: () => readStorageRef.current(),
      onStorageWrite: (key, value) => {
        storageWriteRef.current(key, value)
      },
      post: (json) => {
        const mounted = viewRef.current
        return mounted === null || mounted.sessionId !== sessionId
          ? Promise.reject(new BridgeViewGoneError())
          : mounted.handle.postBridgeMessage(json)
      },
      onDiagnostic: createBridgeDiagnosticReporter()
    })
    hostRef.current = { sessionId, host }
    // The count belongs to this host, so a rebuild starts it over. Without this the screen keeps
    // the retired host's number and the next drop reports the new host's first, so the line falls —
    // which reads as frames coming back rather than as a fresh count.
    binaryFramesDroppedRef.current(0)
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
    )
  }
}
