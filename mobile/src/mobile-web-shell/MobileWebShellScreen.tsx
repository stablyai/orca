import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRouter } from 'expo-router'
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
import {
  formatMobileWebShellDevFacts,
  isDevelopmentBuild,
  useMobileWebShellDroppedFrames
} from './mobile-web-shell-dev-facts'
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
import { SHELL_OPENING_LABEL, ShellPageCover, ShellWaitingFrame } from './ShellWaitingFrame'
import { pageSafeAreaInsets, usePublishedSafeAreaInsets } from './page-safe-area-insets'
import { shellKeyboardGeometry } from './page-keyboard-inset'
import { hostOs } from '../platform/host-os'

function failureMessage(reason: MobileWebShellFailureCause): string {
  switch (reason) {
    case 'isolation-unavailable':
      return "This device's WebView is too old to open the workspace safely."
    case 'download-failed':
      return 'The workspace could not be downloaded from this host.'
    case 'status-unreadable':
      return "Could not read this host's status. Go back and reopen it."
    case 'render-process-gone':
      return 'The workspace stopped responding.'
    case 'generation-unreadable':
    case 'document-load-failed':
      return 'The downloaded workspace could not be opened.'
  }
}

/** Says what happened and what is on screen because of it, and claims nothing else: the shell does
 *  not schedule a second attempt, so this must not promise one. */
function updateNoticeMessage(notice: MobileWebShellUpdateNotice): string {
  switch (notice) {
    case 'update-failed':
      return "Couldn't update the workspace from this host. Showing the last version that worked."
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

function Fetching({ state }: { state: Extract<MobileWebShellSessionState, { kind: 'fetching' }> }) {
  return (
    <Centered>
      <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Downloading workspace" />
      <Text style={styles.waitingLabel}>Downloading workspace</Text>
      <Text style={styles.progress} testID="mobile-web-shell-progress">
        {`${state.completedAssets}/${state.totalAssets} files · ${state.receivedBytes}/${state.totalBytes} bytes`}
      </Text>
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

function DevFacts({
  state,
  droppedBinaryFrames
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'ready' }>
  droppedBinaryFrames: number
}) {
  if (!isDevelopmentBuild()) {
    return null
  }
  return (
    <View style={styles.devFacts} pointerEvents="none">
      <Text style={styles.devFactsText} testID="mobile-web-shell-dev-facts">
        {formatMobileWebShellDevFacts({
          buildId: state.buildId,
          totalBytes: state.totalBytes,
          elapsedMs: state.elapsedMs,
          droppedBinaryFrames
        })}
      </Text>
    </View>
  )
}

export type MobileWebShellScreenProps = {
  hostId: string
  /** The screen this shell stands in for, which the page cannot derive from a document served at `/`. */
  route: BridgeInitRoute
  /**
   * What to render when the bundle does not list this route, or lists it needing a grant this app
   * does not implement. Required, because every caller has a native screen behind it: that is what
   * the negotiation falls back to, and a shell with nothing behind it would paint a blank instead.
   */
  fallback: ReactNode
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
  fallback,
  onRouteParamClear,
  runtime
}: MobileWebShellScreenProps) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const navigation = useNavigation()
  const popShellStack = useShellStackPop()
  const { droppedBinaryFrames, reportDroppedBinaryFrames } = useMobileWebShellDroppedFrames()
  const {
    state,
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
    pageOwnsSafeArea,
    pageReadsKeyboardInset
  } = useMobileWebShellSession({ hostId, routePathname: route.pathname, runtime })
  // Which mount the notice was dismissed on, not whether it was: a later refusal opens its own
  // generation under a new session id, so it is not silenced by a tap on the one before it.
  const [noticeDismissedFor, setNoticeDismissedFor] = useState<string | null>(null)
  const noticeShown =
    updateNotice !== null && state.kind === 'ready' && noticeDismissedFor !== state.sessionId
  // The page cannot see the IME for itself: edge-to-edge makes `adjustResize` inert and the view's
  // IME insets are zeroed, so `visualViewport` never shrinks. A page that reads the height from
  // `init` is covered by the keyboard like a native screen; an older one gets a view ended above it.
  const { keyboardInset, viewShortenedBy } = shellKeyboardGeometry({
    keyboardHeight: useKeyboardOcclusion(),
    bottomInset: insets.bottom,
    platform: hostOs(),
    pageReadsKeyboardInset
  })
  const pageInsets = pageSafeAreaInsets({
    insets,
    viewShortenedBy,
    topCovered: noticeShown
  })
  const { snapshot, unreadable, readStorage, refreshStorage, writeStorage } = usePageHostSnapshot(
    hostId,
    route.pathname
  )
  // Declared before the bridge so the handler it is handed already belongs to this session: the
  // media verbs hold staged files, and a registry born after the host would outlive the page.
  const serveNativeVerb = useNativeDeviceVerbs(state.kind === 'ready' ? state.sessionId : null)
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
      reportShellFailure('document-load-failed')
    },
    // The `init` this ready is answered with is already built from the app's writes, which reach
    // the map as they are made. This re-seats that map on the store afterwards, for the key whose
    // write never persisted, and it runs on every ask because a document that reloads inside this
    // mount asks again.
    onPageReady: (ready) => {
      reportPageReady(ready)
      void refreshStorage()
    },
    // The one thing that says the page is something to look at. The cover below stays up until it
    // lands, for a page that declared it would send one.
    onPagePainted: reportPagePainted,
    // While this is true the key below belongs to the page, not to the stack this screen sits on.
    onPageBackClaim: reportPageBackClaim,
    onRouteParamClear: (param, value) => {
      onRouteParamClear?.(param, value)
    },
    // `document-load-failed` because that is what happens: the document loads and the page refuses
    // the session, so no tree is ever built. The refetch it costs is wasted on a route this shell
    // produced, and the second report is terminal, which is the failure screen this deserves.
    onRouteRefused: (issue) => {
      console.warn('[web-shell] refused to open this screen', issue)
      reportShellFailure('document-load-failed')
    },
    // Pushed, never replaced: the page stays mounted underneath, so Back reveals it with no
    // download and no second `init`.
    onNavigate: (href: string) => {
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

  // A route that moved under a screen that stayed mounted: the session switch keeps `paneKey` out
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

  if (state.kind === 'native-route') {
    return fallback
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
          Connect to this host to download the workspace
        </Text>
      </Centered>
    )
  }
  if (state.kind === 'fetching') {
    return <Fetching state={state} />
  }
  if (state.kind !== 'ready') {
    return <Waiting label={state.kind === 'activating' ? SHELL_OPENING_LABEL : 'Checking host'} />
  }
  return (
    <View
      style={[
        styles.shellRoot,
        // Edge-to-edge like a native screen, for a page that pads for the bars itself; an older page
        // keeps the strips. The banner takes the status bar strip when it shows.
        pageOwnsSafeArea
          ? { paddingTop: noticeShown ? insets.top : 0, paddingBottom: viewShortenedBy }
          : { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, viewShortenedBy) }
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
        style={styles.shellView}
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
      <ShellPageCover label={SHELL_OPENING_LABEL} visible={pageFrame === 'unpainted'} />
      <DevFacts state={state} droppedBinaryFrames={droppedBinaryFrames} />
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
  progress: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.sm
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
  },
  devFacts: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  devFactsText: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
