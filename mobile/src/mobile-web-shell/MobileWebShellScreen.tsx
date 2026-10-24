import { useEffect, useState, type ReactNode } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useNavigationContainerRef, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  OrcaMobileWebShellView,
  parseMobileWebShellLoadState
} from '../../modules/orca-mobile-web-shell/src'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { ProtocolBlockScreen } from '../components/ProtocolBlockScreen'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type {
  MobileWebShellFailureCause,
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'
import { useMobileWebShellDroppedFrames } from './mobile-web-shell-dev-facts'
import { ShellDevFacts } from './ShellDevFacts'
import { cancelledShellNavigationTarget } from './cancelled-navigation-target'
import { playPageHaptic } from './page-haptics'
import { useMobileWebShellBridge } from './use-mobile-web-shell-bridge'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { useNativeDeviceVerbs } from '../platform/use-native-device-verbs'
import { useShellPageBack } from './use-shell-page-back'
import { useShellStackPop } from './use-shell-stack-pop'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'
import { usePageHostSnapshot } from './use-page-host-snapshot'
import { useReportedHostAreaServing } from './host-area-serving'
import { isHostRouteOf } from './page-route-policy'
import { nativeStackReturn } from './native-stack-return'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { storageReadParamsSchema, type BridgeNativeVerb } from './bridge/bridge-native-verbs'
import { SHELL_OPENING_LABEL, ShellPageCover, ShellWaitingFrame } from './ShellWaitingFrame'
import { ShellDownloadProgress } from './ShellDownloadProgress'
import { useReportedShellOverlayLoad, type ShellOverlayLoad } from './shell-overlay-load'
import { pageSafeAreaInsets, usePublishedSafeAreaInsets } from './page-safe-area-insets'
import { hostProfileUnreadableLine, pageFaultLine } from './shell-lifecycle-log'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'

function failureMessage(reason: MobileWebShellFailureCause): string {
  switch (reason) {
    case 'isolation-unavailable':
      return "This device's WebView is too old to open the workspace safely."
    case 'download-failed':
      return 'The latest app could not be downloaded from this host.'
    case 'status-unreadable':
      return "Could not read this host's status. Go back and reopen it."
    case 'render-process-gone':
      return 'The workspace stopped responding.'
    case 'generation-unreadable':
    case 'document-load-failed':
      return 'The downloaded app could not be opened.'
  }
}

/** Says what happened and what is on screen because of it, and claims nothing else: the shell does
 *  not schedule a second attempt, so this must not promise one. */
function updateNoticeMessage(notice: MobileWebShellUpdateNotice): string {
  switch (notice) {
    case 'update-failed':
      return "Couldn't download the latest app from this host. Showing the last version that worked."
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}

function Waiting({ label }: { label: string }) {
  return (
    <Centered>
      <ShellWaitingFrame label={label} />
    </Centered>
  )
}

function Failed({
  state,
  onRetry
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'failed' }>
  onRetry: () => void
}) {
  // No retry for the fence, and none for an unread status: a device whose WebView cannot be
  // isolated will not grow one on a tap, and a retry re-reads the same settled gate it already has.
  const retryable = state.reason !== 'isolation-unavailable' && state.reason !== 'status-unreadable'
  return (
    <Centered>
      <Text style={styles.failedMessage} testID="mobile-web-shell-failed">
        {failureMessage(state.reason)}
      </Text>
      {retryable ? (
        <Pressable
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          testID="mobile-web-shell-retry"
          onPress={onRetry}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      ) : null}
    </Centered>
  )
}

export type MobileWebShellScreenProps = {
  hostId: string
  /** Makes this an overlay: transparent over the screen that opened it, whose page draws a drawer.
   *  The caller shows the wait and the exits; this shows nothing until the page has painted. */
  onOverlayLoad?: (load: ShellOverlayLoad) => void
  /** The screen this shell stands in for, which the page cannot derive from a document served at `/`. */
  route: BridgeInitRoute
  /** False for the catch-all, whose pathnames have no screen in this app. */
  appNamesRoute?: boolean
  /**
   * The page applied a one-shot route param and asks for it to be erased (ruling 34), naming what
   * it applied. Only a caller that put one on the route ever hears this, and the comparison is
   * that caller's: it holds the param, and a tap that moved on since leaves a newer value there.
   */
  onRouteParamClear?: (param: BridgeClearableRouteParam, value: string) => void
  runtime?: MobileWebShellRuntime
}

/**
 * The hybrid shell route's screen: one generation, rendered by the native view, or the plain state
 * that says why it is not.
 *
 * The native view is keyed on the session id, so a remount the reducer asks for is a new key and a
 * rebuilt WebView with every fence reinstalled — the view has no reload of its own by design.
 */
export function MobileWebShellScreen({
  hostId,
  route,
  appNamesRoute,
  onRouteParamClear,
  onOverlayLoad,
  runtime
}: MobileWebShellScreenProps) {
  const insets = useSafeAreaInsets()
  const overlay = onOverlayLoad !== undefined
  const router = useRouter()
  const navigation = useNavigation()
  const navigationContainer = useNavigationContainerRef()
  const popShellStack = useShellStackPop()
  const { isWideLayout } = useResponsiveLayout()
  const { droppedBinaryFrames, reportDroppedBinaryFrames } = useMobileWebShellDroppedFrames()
  const {
    state,
    downloadProgress,
    pageRoutes,
    pageRouteGrants,
    routeGrants,
    updateNotice,
    retry,
    reportShellFailure,
    reportDocumentStarted,
    reportDocumentLoaded,
    reportPageReady,
    reportPagePainted,
    reportPageBackClaim,
    pageReady,
    pageFrame,
    backClaimed,
    ownsHostArea
  } = useMobileWebShellSession({
    hostId,
    routePathname: route.pathname,
    wide: isWideLayout,
    appNamesRoute,
    runtime
  })
  // Full screen from the download on, as on a phone; while checking, nobody knows the page owns it.
  useReportedHostAreaServing(ownsHostArea && state.kind !== 'checking')
  // Which mount the notice was dismissed on, not whether it was: a later refusal opens its own
  // generation under a new session id, so it is not silenced by a tap on the one before it.
  const [noticeDismissedFor, setNoticeDismissedFor] = useState<string | null>(null)
  const noticeShown =
    updateNotice !== null && state.kind === 'ready' && noticeDismissedFor !== state.sessionId
  // The page cannot see the IME for itself: edge-to-edge makes `adjustResize` inert and the view's
  // IME insets are zeroed, so `visualViewport` never shrinks. The keyboard covers the view like a
  // native screen, and the page lifts by the height native screens read.
  const keyboardInset = Math.max(0, useKeyboardOcclusion())
  const pageInsets = pageSafeAreaInsets({ insets, topCovered: noticeShown })
  const { snapshot, unreadable, readStorage, refreshStorage, writeStorage, readWorkspaceKey } =
    usePageHostSnapshot(hostId, route.pathname, ownsHostArea)
  // Declared before the bridge so the handler it is handed already belongs to this session: the
  // media verbs hold staged files, and a registry born after the host would outlive the page.
  const serveDeviceVerb = useNativeDeviceVerbs(state.kind === 'ready' ? state.sessionId : null)
  // The storage read is the shell's own store rather than the device's, scoped to this host.
  const serveNativeVerb = (verb: BridgeNativeVerb, params: unknown): Promise<unknown> =>
    verb === 'native.storage.read'
      ? readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({ value }))
      : serveDeviceVerb(verb, params)
  // Straight to the system handler, and the one opener the shell has: the page's `externalLink`
  // notify and a cancelled top-frame navigation both arrive here already filtered. The only failure
  // left is a device with nothing registered for the scheme -- a `mailto:` on a phone with no mail
  // account. Reported rather than swallowed, because nothing crosses back for either path, and not
  // rethrown, because both run on a native frame handler.
  const openUrlForPage = (url: string) => {
    void Linking.openURL(url).catch((error: unknown) => {
      console.warn('[web-shell] could not open a URL for the page', { url, error })
    })
  }

  const bridge = useMobileWebShellBridge({
    hostId,
    route,
    safeAreaInsets: pageInsets,
    keyboardInset,
    pageRoutes,
    pageRouteGrants,
    routeGrants,
    ownsHostArea,
    session: state,
    sessionEstablished: pageReady,
    snapshot,
    readStorage,
    onStorageWrite: writeStorage,
    // Reported as the document failing to load, which is what it is: the document loaded and never
    // produced a tree. That reason drops this generation and downloads once, so a page broken by
    // bytes this host has since replaced recovers, and a page broken by its own code stops at the
    // failure screen instead of a blank one.
    // Must not throw: it runs inside the page's own error boundary on one side and the native frame
    // handler on the other, and neither has anywhere to put a throw.
    onPageFault: (error) => {
      console.warn('[web-shell] the page faulted', error)
      recordShellLifecycleLine(hostId, pageFaultLine(error))
      reportShellFailure('document-load-failed')
    },
    // The `init` this ready is answered with is already built from the app's writes, which reach
    // the map as they are made. This re-seats that map on the store afterwards, for the key whose
    // write never persisted, and it runs on every ask because a document that reloads inside this
    // mount asks again.
    onPageReady: () => {
      reportPageReady()
      void refreshStorage()
    },
    // The one thing that says the page is something to look at. The cover below stays up until it
    // lands.
    onPagePainted: reportPagePainted,
    // While this is true the key below belongs to the page, not to the stack this screen sits on.
    onPageBackClaim: reportPageBackClaim,
    onRouteParamClear: (param, value) => {
      onRouteParamClear?.(param, value)
    },
    // `document-load-failed` because that is what happens: the document loads and the page refuses
    // the session, so no tree is ever built. The refetch it costs is wasted on a route this shell
    // produced, and the second report is terminal, which is the failure screen this deserves.
    // Logged by the host's `route-refused` diagnostic, which carries the issue, in the same call.
    onRouteRefused: (issue) => {
      console.warn('[web-shell] refused to open this screen', issue)
      reportShellFailure('document-load-failed')
    },
    // A new screen is pushed, never replaced: the page stays mounted underneath, so Back reveals it
    // with no download and no second `init`.
    onNavigate: (href: string) => {
      // An overlay hands its place to where the page went: Back there returns to the screen beneath.
      if (overlay) {
        return void router.replace(href)
      }
      // A screen already on the stack is returned to, as system Back would: the page's own exits
      // ask for the screen beneath it, and a push would stack a second copy over a live one.
      const rootState = navigationContainer.getRootState()
      const onStack = rootState ? nativeStackReturn(rootState, href) : null
      if (onStack === 'current') {
        return
      }
      if (onStack) {
        navigation.dispatch({
          type: 'POP',
          payload: { count: onStack.count },
          target: onStack.target,
          source: onStack.source
        })
        return
      }
      // Wide, this host's route is the area-owning session even when it is not on the stack as
      // asked: `dismissTo` pops to it by name with the href's params, or replaces this one after a
      // cold deep link, so it is never a second on top.
      if (isWideLayout && isHostRouteOf(href, hostId)) {
        router.dismissTo(href)
        return
      }
      router.push(href)
    },
    // Answered on this device and never forwarded; the host holds it to the verb table first.
    serveNativeVerb,
    // Straight to the system handler. The envelope allowlisted the scheme before this ran, so the
    // only failure left is a device with nothing registered for it — a `mailto:` on a phone with no
    // mail account. Reported rather than swallowed: nothing crosses back for a notify, so this is
    // the one dead tap the verb does not rule out, and silence is what would hide it. Still not
    // rethrown, because this runs on the native frame handler.
    // The same opener a cancelled top-frame navigation takes, hoisted above this call so both
    // paths are one function: its body is the `Linking.openURL` and the warning this handler
    // carried inline.
    onExternalLink: openUrlForPage,
    // The app's own haptics, reached through one mapping rather than a second copy of the
    // `Platform.OS` split. Nothing crosses back and nothing can fail: each function already
    // swallows its own rejection on the device.
    onHaptic: playPageHaptic,
    // The page's own Back goes nowhere: it holds the one history entry the entry wrote, so the only
    // stack to pop is this one.
    onNavigateBack: popShellStack,
    // A dropped screencast frame leaves no other trace on a device: the stream stays up by design
    // and the diagnostic beside it prints once per host.
    onBinaryFramesDropped: reportDroppedBinaryFrames
  })

  // A route that moved under a screen that stayed mounted: the session route keeps `paneKey` out
  // of its key so a notification tap for another pane is a tab switch rather than a page reload,
  // and this is how the page hears about it. Nothing is tracked here — which route the page has,
  // and which one is still owed it, belong to the host, which outlives any one run of this effect.
  // All this says is what the screen is on now: a route that did not move is dropped there, and a
  // frame in flight when this re-runs is not disturbed by it.
  const publishRoute = bridge.publishRoute
  useEffect(() => {
    publishRoute(route)
  }, [publishRoute, route])

  usePublishedSafeAreaInsets(bridge.publishSafeAreaInsets, pageInsets)
  // Every keyboard event, a height change while open included, so the page never holds a stale one.
  const publishKeyboardInset = bridge.publishKeyboardInset
  useEffect(() => {
    publishKeyboardInset(keyboardInset)
  }, [publishKeyboardInset, keyboardInset])

  // The navigation object rather than the router: what this takes away is this screen's own place
  // on the stack, which is a screen option, and the router has no member that says it.
  useShellPageBack({
    claimed: backClaimed,
    sendBack: bridge.sendBack,
    setOptions: navigation.setOptions
  })
  useReportedShellOverlayLoad(onOverlayLoad, state, pageFrame, downloadProgress)

  // A profile read that rejected never becomes a host, so the session would otherwise sit in
  // `ready` behind an un-hidden view with nothing serving it and the page asking forever.
  // `document-load-failed` because that is the outcome: the document loads and no session opens.
  // The refetch it costs is wasted on a device-local read, and the second report is terminal, which
  // is the failure screen with a Try again this deserves.
  useEffect(() => {
    if (unreadable) {
      console.warn('[web-shell] this host could not be read from the app store')
      reportShellFailure('document-load-failed')
    }
  }, [reportShellFailure, unreadable])
  // Log-only and separate, so the failure effect above keeps its own dependencies.
  useEffect(() => {
    if (unreadable) {
      recordShellLifecycleLine(hostId, hostProfileUnreadableLine())
    }
  }, [hostId, unreadable])

  // The overlay's caller draws the wait and the exits.
  if (overlay && state.kind !== 'ready') {
    return null
  }
  if (state.kind === 'route-unavailable') {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  if (state.kind === 'wall') {
    return <ProtocolBlockScreen verdict={state.verdict} />
  }
  if (state.kind === 'failed') {
    return <Failed state={state} onRetry={retry} />
  }
  if (state.kind === 'offline') {
    return (
      <Centered>
        <Text style={styles.waitingLabel} testID="mobile-web-shell-offline">
          Connect to this host to download the latest app
        </Text>
      </Centered>
    )
  }
  if (state.kind === 'fetching') {
    return (
      <Centered>
        <ShellDownloadProgress
          state={state}
          feed={downloadProgress}
          host={snapshot?.host ?? null}
        />
      </Centered>
    )
  }
  if (state.kind !== 'ready') {
    return <Waiting label={state.kind === 'activating' ? SHELL_OPENING_LABEL : 'Checking host'} />
  }
  return (
    <View
      style={[
        styles.shellRoot,
        // Edge-to-edge like a native screen: the page pads for the bars itself from the insets
        // `init` carries. The banner takes the status bar strip when it shows.
        { paddingTop: noticeShown ? insets.top : 0 },
        // An overlay's page draws over the screen beneath, which shows through.
        overlay && { backgroundColor: 'transparent' }
      ]}
      testID="mobile-web-shell-ready"
    >
      {/* Above the page and dismissible, never in front of it: the workspace below this line
          works, and the only thing that did not happen is the update to a newer one. */}
      {updateNotice !== null && noticeShown && (
        <HostRouteNoticeBanner
          message={updateNoticeMessage(updateNotice)}
          tone="failure"
          onDismiss={() => setNoticeDismissedFor(state.sessionId)}
        />
      )}
      <OrcaMobileWebShellView
        key={state.sessionId}
        ref={bridge.viewRef}
        // An overlay has no cover over the screen beneath: a fresh WebView draws opaque until the page paints.
        style={[styles.shellView, overlay && pageFrame !== 'painted' && styles.unpaintedOverlay]}
        generationDirectory={state.generationDirectory}
        sessionId={state.sessionId}
        bridgeEnabled={bridge.bridgeEnabled}
        onBridgeMessage={bridge.onBridgeMessage}
        onExternalNavigation={(event) => {
          const target = cancelledShellNavigationTarget(event.nativeEvent.url)
          if (target === null) {
            // Cancelled and not openable. Nothing naming the shell's own document reaches here:
            // the shell refuses that without offering it, whatever asked. What lands here and is
            // dropped is a URL outside the three allowed schemes. Silent, as every cancelled
            // navigation was before this event existed.
            return
          }
          openUrlForPage(target)
        }}
        onLoadState={(event) => {
          const parsed = parseMobileWebShellLoadState(event.nativeEvent)
          if (parsed?.state === 'failed') {
            reportShellFailure(parsed.reason)
            return
          }
          // A finished document is not a working one. The WebView says the response committed; only
          // the page's own first frame says its code ran, so this is where the wait for it starts.
          if (parsed?.state === 'ready') {
            reportDocumentLoaded()
            return
          }
          // The view is drawing the document it is leaving until the new one paints, so the cover
          // goes back up here rather than on the `ready` that follows it.
          if (parsed?.state === 'loading') {
            reportDocumentStarted()
          }
        }}
      />
      {overlay ? null : (
        <ShellPageCover label={SHELL_OPENING_LABEL} visible={pageFrame === 'unpainted'} />
      )}
      <ShellDevFacts state={state} droppedBinaryFrames={droppedBinaryFrames} />
    </View>
  )
}

const styles = StyleSheet.create({
  shellRoot: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  shellView: {
    flex: 1
  },
  unpaintedOverlay: {
    opacity: 0
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  waitingLabel: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center'
  },
  failedMessage: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.lg
  },
  retryButton: {
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button
  },
  retryLabel: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  pressed: {
    opacity: 0.7
  }
})
