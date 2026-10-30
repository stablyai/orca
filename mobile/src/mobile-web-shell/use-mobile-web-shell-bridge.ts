import type {
  BridgeTerminalToolbar,
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from './bridge/bridge-terminal-key'
import type { BridgePageGeometry } from './bridge/bridge-page-geometry'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type {
  MobileWebShellBridgeMessagePayload,
  OrcaMobileWebShellViewHandle
} from '../../modules/orca-mobile-web-shell/src'
import { useHostClient } from '../transport/host-client-hooks'
import { createBridgeDiagnosticReporter } from './bridge-diagnostic-log'
import { bridgeDiagnosticLine, frameWithoutHostLine } from './shell-bridge-log-lines'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'
import type { BridgeColorScheme, BridgeInitRoute, BridgeUiLocale } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import type { BridgeFoldDivision } from './bridge/bridge-fold-division'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import { createBridgeHost, type BridgeHost } from './bridge-host'
import type { BridgeSessionBack } from './bridge-host-back'
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

// Stamp both refs with their session: React attaches replacement refs before retired cleanup, which must not post teardown frames into the new page.
type MountedView = { sessionId: string; handle: OrcaMobileWebShellViewHandle }
type MountedHost = { sessionId: string; host: BridgeHost }
type EstablishedBack = { sessionId: string; back: BridgeSessionBack }

export type MobileWebShellBridgeMessageEvent = {
  readonly nativeEvent: MobileWebShellBridgeMessagePayload
}

export type MobileWebShellBridgeView = {
  // Keep bridgeEnabled tied to ready, not client arrival: toggling it reloads native. Without a client, let the page retry ready until a host can answer.
  readonly bridgeEnabled: boolean
  readonly viewRef: (handle: OrcaMobileWebShellViewHandle | null) => void
  readonly onBridgeMessage: (event: MobileWebShellBridgeMessageEvent) => void
  /**
   * Hands the mounted host a rewritten route for the screen it is already serving. Dropped when
   * there is no host yet; the route the host is built from carries it instead.
   */
  readonly publishStorage: () => void
  readonly publishRoute: (route: BridgeInitRoute) => void
  readonly publishSafeAreaInsets: (insets: BridgeSafeAreaInsets) => void
  readonly publishKeyboardInset: (height: number) => void
  /** Hands the mounted host a moved fold; dropped with no host, as the insets are. */
  readonly publishFoldDivision: (division: BridgeFoldDivision | null) => void
  /** Tells the mounted host the key rail shows or hides; dropped with no host. */
  readonly publishTerminalKeyRail: (keys: BridgeTerminalKeyRail) => void
  /** Hands the page one rail press. False with no host, or a page not granted the rail. */
  readonly sendTerminalKey: (key: BridgeTerminalKeyId, inputOwner?: string) => boolean
  /**
   * Hands the mounted host one Back press. False when there is no host, or when the document it
   * serves never said it takes one — the caller then leaves the key to the navigator.
   */
  readonly sendBack: () => boolean
}

export type MobileWebShellBridgeArgs = {
  hostId: string
  session: MobileWebShellSessionState
  // Handshake belongs to the reducer’s session; client replacement rebuilds the host under the same document without a new ready.
  sessionEstablished: boolean
  route: BridgeInitRoute
  safeAreaInsets: BridgeSafeAreaInsets
  keyboardInset: number
  /** What the first `init` of a new host carries; later moves go through `publishFoldDivision`. */
  pageGeometry?: BridgePageGeometry
  foldDivision: BridgeFoldDivision | null
  /** What the first `init` of a new host carries; later moves go through `publishTerminalKeyRail`. */
  terminalKeyRail: BridgeTerminalKeyRail
  colorScheme: BridgeColorScheme
  uiLocale: BridgeUiLocale
  /** The route patterns the page keeps for itself; everything else comes back as `navigate`. */
  pageRoutes: readonly string[]
  pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  // Effective session grants include the served-route union when this page owns the host area.
  routeGrants: readonly string[]
  ownsHostArea?: boolean
  onNavigate: (href: string, replace: boolean) => void
  onExternalLink: (url: string) => void
  onHaptic: (kind: BridgeHapticsKind) => void
  serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  onNavigateBack: () => BridgeNavigateBackOutcome
  // Wait for host profile and storage before building the host, or its first init would mount a page against missing identity/preferences.
  snapshot: PageHostSnapshot | null
  readStorage: () => PageStorageForInit
  onStorageWrite: (key: string, value: string | null) => void
  onPageFault: (error: BridgeErrorCapture) => void
  onPageReady: () => void
  onPagePainted: () => void
  // Document resets explicitly publish false so retired pages cannot retain Back.
  onPageBackClaim: (claimed: boolean) => void
  onPageLocation: (href: string) => void
  /** The page shows a terminal with its key row, or stopped; false again on each new document. */
  onTerminalKeyRailClaim: (
    claimed: boolean,
    inputOwner?: string,
    toolbar?: BridgeTerminalToolbar
  ) => void
  /** The page applied a one-shot route param and asks for it to be erased (ruling 34). */
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  onRouteRefused: (issue: string) => void
  onBinaryFramesDropped: (total: number) => void
}

// Use reducer-owned session ids for the bridge; remount ids let native origin checks reject retired-document frames.
export function useMobileWebShellBridge(args: MobileWebShellBridgeArgs): MobileWebShellBridgeView {
  const { client, clientId } = useHostClient(args.hostId)
  const ready = args.session.kind === 'ready' ? args.session : null
  const sessionId = ready?.sessionId ?? null
  const buildId = ready?.buildId ?? null
  const viewRef = useRef<MountedView | null>(null)
  const hostRef = useRef<MountedHost | null>(null)
  // Preserve Back across same-document client rebuilds, stamped by session so the next document cannot inherit it.
  const establishedBackRef = useRef<EstablishedBack | null>(null)
  // Hold fresh props in a ref so renders cannot rebuild the host and settle pending work; paneKey updates publish init without remounting (ruling 33.1).
  const argsRef = useRef(args)
  // Read identity lazily without rebuilding a live host just to refresh a string.
  const clientIdRef = useRef(clientId)
  const clientRef = useRef(client)
  const droppedFrameLoggedRef = useRef<string | null>(null)
  // Update refs on every commit before host construction; native frames may arrive before passive effects.
  useLayoutEffect(() => {
    argsRef.current = args
    clientIdRef.current = clientId
    clientRef.current = client
  })
  const snapshot = args.snapshot

  // Replace the host on commit so same-session native frames cannot reach a retired client in the passive-effect gap.
  useLayoutEffect(() => {
    if (client === null || sessionId === null || buildId === null || snapshot === null) {
      return
    }
    const latest = argsRef.current
    // Read callbacks from the current committed ref; captured render closures would outlive their screen state.
    const host = createBridgeHost({
      client,
      buildId,
      sessionId,
      route: latest.route,
      safeAreaInsets: latest.safeAreaInsets,
      keyboardInset: latest.keyboardInset,
      pageGeometry: latest.pageGeometry,
      foldDivision: latest.foldDivision,
      terminalKeyRail: latest.terminalKeyRail,
      colorScheme: latest.colorScheme,
      uiLocale: latest.uiLocale,
      pageRoutes: latest.pageRoutes,
      pageRouteGrants: latest.pageRouteGrants,
      routeGrants: latest.routeGrants,
      ownsHostArea: latest.ownsHostArea === true,
      sessionEstablished: latest.sessionEstablished,
      ...(establishedBackRef.current?.sessionId === sessionId
        ? { sessionBack: establishedBackRef.current.back }
        : {}),
      host: snapshot.host,
      readClientIdentity: () => clientIdRef.current,
      post: (json) => {
        const mounted = viewRef.current
        return mounted === null || mounted.sessionId !== sessionId
          ? Promise.reject(new BridgeViewGoneError())
          : mounted.handle.postBridgeMessage(json)
      },
      onDiagnostic: createBridgeDiagnosticReporter((diagnostic) => {
        const line = bridgeDiagnosticLine(diagnostic)
        if (line !== null) {
          recordShellLifecycleLine(latest.hostId, line)
        }
      }),
      onNavigate: (href, replace) => argsRef.current.onNavigate(href, replace),
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
      onPageReady: () => argsRef.current.onPageReady(),
      onPagePainted: () => argsRef.current.onPagePainted(),
      onPageBackClaim: (claimed) => argsRef.current.onPageBackClaim(claimed),
      onPageLocation: (href) => argsRef.current.onPageLocation(href),
      onTerminalKeyRailClaim: (claimed, inputOwner, toolbar) =>
        argsRef.current.onTerminalKeyRailClaim(claimed, inputOwner, toolbar)
    })
    hostRef.current = { sessionId, host }
    // Reset host-owned drop totals on rebuild so a new lower count cannot look like frames being recovered.
    latest.onBinaryFramesDropped(0)
    return () => {
      // Capture Back before disposal so the next host for this document inherits it.
      establishedBackRef.current = { sessionId, back: host.readSessionBack() }
      hostRef.current = null
      host.dispose()
    }
  }, [buildId, client, sessionId, snapshot])

  useEffect(() => {
    const mounted = hostRef.current
    if (mounted !== null && mounted.sessionId === sessionId && args.pageGeometry !== undefined) {
      mounted.host.publishPageGeometry(args.pageGeometry)
    }
  }, [buildId, client, sessionId, snapshot, args.pageGeometry])

  // A rebuilt host already starts from the latest scheme; this re-sends init when it changes under a live page.
  const colorScheme = args.colorScheme
  useEffect(() => {
    const mounted = hostRef.current
    if (mounted !== null && mounted.sessionId === sessionId) {
      mounted.host.publishColorScheme(colorScheme)
    }
  }, [colorScheme, sessionId])

  const uiLocale = args.uiLocale
  useEffect(() => {
    const mounted = hostRef.current
    if (mounted !== null && mounted.sessionId === sessionId) {
      mounted.host.publishUiLocale(uiLocale)
    }
  }, [uiLocale, sessionId])

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
    publishStorage: useCallback(() => {
      const mounted = hostRef.current
      if (mounted !== null && mounted.sessionId === sessionId) {
        mounted.host.publishStorage()
      }
    }, [buildId, client, sessionId, snapshot]),
    publishRoute: useCallback(
      (route: BridgeInitRoute) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishRoute(route)
        }
      },
      [buildId, client, sessionId, snapshot]
    ),
    publishSafeAreaInsets: useCallback(
      (insets: BridgeSafeAreaInsets) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishSafeAreaInsets(insets)
        }
      },
      [buildId, client, sessionId, snapshot]
    ),
    publishKeyboardInset: useCallback(
      (height: number) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishKeyboardInset(height)
        }
      },
      [buildId, client, sessionId, snapshot]
    ),
    publishFoldDivision: useCallback(
      (division: BridgeFoldDivision | null) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishFoldDivision(division)
        }
      },
      [buildId, client, sessionId, snapshot]
    ),
    publishTerminalKeyRail: useCallback(
      (keys: BridgeTerminalKeyRail) => {
        const mounted = hostRef.current
        if (mounted !== null && mounted.sessionId === sessionId) {
          mounted.host.publishTerminalKeyRail(keys)
        }
      },
      [buildId, client, sessionId, snapshot]
    ),
    sendTerminalKey: useCallback(
      (key: BridgeTerminalKeyId, inputOwner?: string) => {
        const mounted = hostRef.current
        return (
          mounted !== null &&
          mounted.sessionId === sessionId &&
          mounted.host.sendTerminalKey(key, inputOwner)
        )
      },
      [buildId, client, sessionId, snapshot]
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
