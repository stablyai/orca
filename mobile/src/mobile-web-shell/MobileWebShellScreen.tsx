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
import { useNativePdfViewer } from '../platform/native-pdf-view'
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

// Do not promise a retry: the shell schedules no second update attempt.
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
  // Retry cannot change a settled isolation gate or give an unsupported WebView the missing fence.
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
  // Overlay callers draw waiting/exits; stay transparent until the page paints its drawer.
  onOverlayLoad?: (load: ShellOverlayLoad) => void
  // The served document lives at / and cannot derive the native screen’s route.
  route: BridgeInitRoute
  appNamesRoute?: boolean
  // The caller compares the consumed one-shot value before clearing it; a newer tap may already have replaced it (ruling 34).
  onRouteParamClear?: (param: BridgeClearableRouteParam, value: string) => void
  runtime?: MobileWebShellRuntime
}

// Key the native view by session id so reducer-requested remounts rebuild the WebView and reinstall every fence; the view has no independent reload.
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
  // Key dismissal by session id so a new generation’s refusal still appears.
  const [noticeDismissedFor, setNoticeDismissedFor] = useState<string | null>(null)
  const noticeShown =
    updateNotice !== null && state.kind === 'ready' && noticeDismissedFor !== state.sessionId
  // Edge-to-edge disables adjustResize and zeroes WebView IME insets, so visualViewport never shrinks; publish native keyboard height to the page.
  const keyboardInset = Math.max(0, useKeyboardOcclusion())
  const pageInsets = pageSafeAreaInsets({ insets, topCovered: noticeShown })
  const { snapshot, unreadable, readStorage, refreshStorage, writeStorage, readWorkspaceKey } =
    usePageHostSnapshot(hostId, route.pathname, ownsHostArea)
  // Create the media registry before the bridge; its staged files must belong to this page session.
  const serveDeviceVerb = useNativeDeviceVerbs(state.kind === 'ready' ? state.sessionId : null)
  const servePdfView = useNativePdfViewer(hostId, state.kind === 'ready' ? state.sessionId : null)
  const serveNativeVerb = (verb: BridgeNativeVerb, params: unknown): Promise<unknown> =>
    verb === 'native.storage.read'
      ? readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({ value }))
      : verb === 'native.pdf.view'
        ? servePdfView(params)
        : serveDeviceVerb(verb, params)
  // Both externalLink and cancelled navigation use this filtered opener. Report device-handler failure without throwing from a native frame callback; neither path has a reply.
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
    // Treat a page that never renders as document-load-failed: refetch once for replaced bytes, then fail visibly if its code still breaks.
    // Never throw from the page error boundary/native frame callback.
    onPageFault: (error) => {
      console.warn('[web-shell] the page faulted', error)
      recordShellLifecycleLine(hostId, pageFaultLine(error))
      reportShellFailure('document-load-failed')
    },
    // init already sees app writes in the map; refresh from persisted storage afterward on every ready, including document reloads.
    onPageReady: () => {
      reportPageReady()
      void refreshStorage()
    },
    // Keep the cover until the page reports its own first frame.
    onPagePainted: reportPagePainted,
    onPageBackClaim: reportPageBackClaim,
    onRouteParamClear: (param, value) => {
      onRouteParamClear?.(param, value)
    },
    // Route refusal builds no tree; use document-load-failed for bounded recovery, then a terminal failure. The host logs the specific issue.
    onRouteRefused: (issue) => {
      console.warn('[web-shell] refused to open this screen', issue)
      reportShellFailure('document-load-failed')
    },
    // Push so Back reveals the mounted page without downloading or handshaking again.
    onNavigate: (href: string) => {
      if (overlay) {
        return void router.replace(href)
      }
      // Return to an existing screen rather than pushing a duplicate over the live one.
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
      // The wide host route owns the session area; dismissTo pops to it or replaces after a cold deep link, avoiding a second copy.
      if (isWideLayout && isHostRouteOf(href, hostId)) {
        router.dismissTo(href)
        return
      }
      router.push(href)
    },
    serveNativeVerb,
    onExternalLink: openUrlForPage,
    // Reuse the app’s platform haptics mapping; device failures are already swallowed there.
    onHaptic: playPageHaptic,
    // The page has one history entry; only the native stack can handle Back.
    onNavigateBack: popShellStack,
    // The stream survives dropped frames; keep a count because diagnostics print only once per host.
    onBinaryFramesDropped: reportDroppedBinaryFrames
  })

  // paneKey changes keep the session mounted; publish the new route without reloading. The longer-lived host deduplicates routes and preserves any in-flight frame.
  const publishRoute = bridge.publishRoute
  useEffect(() => {
    publishRoute(route)
  }, [publishRoute, route])

  usePublishedSafeAreaInsets(bridge.publishSafeAreaInsets, pageInsets)
  const publishKeyboardInset = bridge.publishKeyboardInset
  useEffect(() => {
    publishKeyboardInset(keyboardInset)
  }, [publishKeyboardInset, keyboardInset])

  // Use navigation screen options to disable this stack entry’s gesture; the router has no such option.
  useShellPageBack({
    claimed: backClaimed,
    sendBack: bridge.sendBack,
    setOptions: navigation.setOptions
  })
  useReportedShellOverlayLoad(onOverlayLoad, state, pageFrame, downloadProgress)

  // A rejected profile read creates no host; fail the document instead of leaving ready forever. Recovery refetches once, then exposes Try again.
  useEffect(() => {
    if (unreadable) {
      console.warn('[web-shell] this host could not be read from the app store')
      reportShellFailure('document-load-failed')
    }
  }, [reportShellFailure, unreadable])
  useEffect(() => {
    if (unreadable) {
      recordShellLifecycleLine(hostId, hostProfileUnreadableLine())
    }
  }, [hostId, unreadable])

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
        // The page pads system bars from init insets; a visible banner owns the status-bar strip.
        { paddingTop: noticeShown ? insets.top : 0 },
        overlay && { backgroundColor: 'transparent' }
      ]}
      testID="mobile-web-shell-ready"
    >
      {/* Keep update-failure notice above the working fallback page so dismissal leaves its document intact. */}
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
        // Overlays cannot cover the screen beneath; hide their opaque WebView until first paint.
        style={[styles.shellView, overlay && pageFrame !== 'painted' && styles.unpaintedOverlay]}
        generationDirectory={state.generationDirectory}
        sessionId={state.sessionId}
        bridgeEnabled={bridge.bridgeEnabled}
        onBridgeMessage={bridge.onBridgeMessage}
        onExternalNavigation={(event) => {
          const target = cancelledShellNavigationTarget(event.nativeEvent.url)
          if (target === null) {
            // Drop schemes outside the three allowed ones; shell-document URLs are already refused before this callback.
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
          // Load completion proves only response commit; start waiting for the page’s own first paint here.
          if (parsed?.state === 'ready') {
            reportDocumentLoaded()
            return
          }
          // Cover on load start: the old document remains visible until the new one paints, before ready arrives.
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
