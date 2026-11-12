import { useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation, useNavigationContainerRef, useRouter } from 'expo-router'
import {
  OrcaMobileWebShellView,
  parseMobileWebShellLoadState
} from '../../modules/orca-mobile-web-shell/src'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileUiLocale } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { MobileWebShellUpdateNotice } from './mobile-web-shell-session-contract'
import { useMobileWebShellDroppedFrames } from './mobile-web-shell-dev-facts'
import { ShellDevFacts } from './ShellDevFacts'
import { cancelledShellNavigationTarget } from './cancelled-navigation-target'
import { playPageHaptic } from './page-haptics'
import { useMobileWebShellBridge } from './use-mobile-web-shell-bridge'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { useNativeDeviceVerbs } from '../platform/use-native-device-verbs'
import { useNativePdfViewer } from '../platform/native-pdf-view'
import { useNativeImageActions } from '../platform/native-image-actions'
import { processDeviceStore } from '../device-store/device-store'
import { serveDeviceStoreVerb } from './device-store-verb-server'
import { BRIDGE_STORE_VERB } from './bridge/bridge-store-verb'
import { useAppLeavesForeground } from './use-app-leaves-foreground'
import { useShellPageBack } from './use-shell-page-back'
import { useShellStackPop } from './use-shell-stack-pop'
import { usePageLocationOnFold } from './page-location-on-fold'
import { usePageOpenTarget } from './page-open-target'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'
import { useShellPageStorageRefresh } from './use-shell-page-storage-refresh'
import { usePageHostSnapshot } from './use-page-host-snapshot'
import { useReportedHostAreaServing } from './host-area-serving'
import { isHostRouteOf } from './page-route-policy'
import { nativeStackReturn } from './native-stack-return'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { storageReadParamsSchema, type BridgeNativeVerb } from './bridge/bridge-native-verbs'
import { SHELL_OPENING_LABEL, ShellPageCover } from './ShellWaitingFrame'
import { ShellStateScreen } from './ShellStateScreen'
import { useReportedShellOverlayLoad, type ShellOverlayLoad } from './shell-overlay-load'
import { pageSafeAreaInsets, usePublishedSafeAreaInsets } from './page-safe-area-insets'
import { usePageFoldDivision, usePublishedFoldDivision } from './page-fold-division'
import { usePublishedShellKeyRail, useShellKeyRail } from './use-shell-key-rail'
import { hostProfileUnreadableLine, pageFaultLine } from './shell-lifecycle-log'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'

// Do not promise a retry: the shell schedules no second update attempt.
function updateNoticeMessage(notice: MobileWebShellUpdateNotice): string {
  switch (notice) {
    case 'update-failed':
      return "Couldn't download the latest app from this host. Showing the last version that worked."
  }
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
  // Where the page has navigated inside its own document; without it the location is only held for a fold.
  onPageLocation?: (href: string) => void
  runtime?: MobileWebShellRuntime
}

// Key the native view by session id so reducer-requested remounts rebuild the WebView and reinstall every fence; the view has no independent reload.
export function MobileWebShellScreen({
  hostId,
  route,
  appNamesRoute,
  onRouteParamClear,
  onPageLocation,
  onOverlayLoad,
  runtime
}: MobileWebShellScreenProps) {
  const colorScheme = useMobileColorScheme()
  const uiLocale = useMobileUiLocale()
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
    ownsHostArea,
    hostStatus
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
  const pageFold = usePageFoldDivision()
  const pageInsets = pageSafeAreaInsets({
    insets: pageFold.safeAreaInsets,
    topCovered: noticeShown
  })
  const readySessionId = state.kind === 'ready' ? state.sessionId : null
  const keyRail = useShellKeyRail({ sessionId: readySessionId, overlay, routeGrants })
  const {
    snapshot,
    unreadable,
    retry: retryHostSnapshot,
    readStorage,
    refreshStorage,
    writeStorage,
    readWorkspaceKey
  } = usePageHostSnapshot(hostId, route.pathname, ownsHostArea)
  // Create the media registry before the bridge; staged files belong to this page session.
  const serveDeviceVerb = useNativeDeviceVerbs(readySessionId)
  const servePdfView = useNativePdfViewer(hostId, readySessionId)
  const serveImageAction = useNativeImageActions(readySessionId)
  // Read the shell's storage for this host.
  const serveNativeVerb = (verb: BridgeNativeVerb, params: unknown): Promise<unknown> =>
    verb === 'native.storage.read'
      ? readWorkspaceKey(storageReadParamsSchema.parse(params).key).then((value) => ({ value }))
      : verb === 'native.pdf.view'
        ? servePdfView(params)
        : verb === 'native.image.act'
          ? serveImageAction(params)
          : verb === BRIDGE_STORE_VERB
            ? serveDeviceStoreVerb(processDeviceStore(), hostId, params)
            : serveDeviceVerb(verb, params)
  // Both externalLink and cancelled navigation use this filtered opener. Report device-handler failure without throwing from a native frame callback; neither path has a reply.
  const openUrlForPage = (url: string) => {
    void Linking.openURL(url).catch((error: unknown) => {
      console.warn('[web-shell] could not open a URL for the page', { url, error })
    })
  }

  // Push so Back reveals the mounted page without downloading or handshaking again, unless the page replaced itself.
  const openPageRoute = (href: string, replace = false) => {
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
    // Host exits preserve notice params and replace cold deep links at either width; plain session exits pop back to their opener when the host list was skipped.
    if (isHostRouteOf(href, hostId)) {
      if (!/[?#]/.test(href) && popShellStack() !== 'nothing-to-pop') {
        return
      }
      router.dismissTo(href)
      return
    }
    return void (replace ? router.replace(href) : router.push(href))
  }
  const openTarget = usePageOpenTarget({
    route,
    sessionId: readySessionId,
    pageVersion: state.kind === 'ready' ? (state.compat.pageVersion ?? 0) : null,
    isFocused: () => navigation.isFocused(),
    openNatively: openPageRoute,
    onRouteParamClear
  })
  const pageRoute = openTarget.pageRoute
  const holdPageLocation = usePageLocationOnFold(
    isWideLayout,
    () => navigation.isFocused(),
    openPageRoute
  )

  const bridge = useMobileWebShellBridge({
    hostId,
    hostStatus,
    route: pageRoute,
    safeAreaInsets: pageInsets,
    keyboardInset,
    pageGeometry: pageFold.geometry,
    foldDivision: pageFold.division,
    terminalKeyRail: keyRail.keys,
    colorScheme,
    uiLocale,
    pageRoutes,
    pageRouteGrants,
    routeGrants,
    ownsHostArea,
    session: state,
    sessionEstablished: pageReady,
    snapshot,
    readStorage,
    onStorageWrite: writeStorage,
    // Treat a page that never renders as document-load-failed: remount the same bytes once, then fail visibly; Try again downloads fresh.
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
    // A caller that tracks the location takes it; pages from #34484 desktops report it only for a fold to reopen.
    onPageLocation: (href) => {
      openTarget.recordLocation(href)
      return onPageLocation === undefined
        ? holdPageLocation(href, ownsHostArea)
        : onPageLocation(href)
    },
    onTerminalKeyRailClaim: keyRail.reportClaim,
    onRouteParamClear: openTarget.onRouteParamClear,
    // Route refusal builds no tree; use document-load-failed for bounded recovery, then a terminal failure. The host logs the specific issue.
    onRouteRefused: (issue) => {
      console.warn('[web-shell] refused to open this screen', issue)
      reportShellFailure('document-load-failed')
    },
    onNavigate: openPageRoute,
    serveNativeVerb,
    onExternalLink: openUrlForPage,
    // Reuse the app’s platform haptics mapping; device failures are already swallowed there.
    onHaptic: playPageHaptic,
    // The page has one history entry; only the native stack can handle Back.
    onNavigateBack: popShellStack,
    // The stream survives dropped frames; keep a count because diagnostics print only once per host.
    onBinaryFramesDropped: reportDroppedBinaryFrames
  })
  useAppLeavesForeground(bridge.sendAppInactive)

  // paneKey changes keep the session mounted; the host deduplicates routes and preserves in-flight frames.
  useShellPageStorageRefresh(refreshStorage, bridge.publishStorage)
  useEffect(() => bridge.publishRoute(pageRoute), [bridge.publishRoute, pageRoute])

  usePublishedSafeAreaInsets(bridge.publishSafeAreaInsets, pageInsets)
  const publishKeyboardInset = bridge.publishKeyboardInset
  useEffect(() => {
    publishKeyboardInset(keyboardInset)
  }, [publishKeyboardInset, keyboardInset])
  usePublishedFoldDivision(bridge.publishFoldDivision, pageFold.division)
  usePublishedShellKeyRail(keyRail.keys, bridge, keyRail.inputOwner, keyRail.toolbar)

  // Use navigation screen options to disable this stack entry’s gesture; the router has no such option.
  useShellPageBack({
    claimed: backClaimed,
    isFocused: () => navigation.isFocused(),
    sendBack: bridge.sendBack,
    setOptions: navigation.setOptions,
    parent: navigation.getParent()
  })
  useReportedShellOverlayLoad(onOverlayLoad, state, pageFrame, downloadProgress)

  // Profile failures preserve verified bundle bytes and retry the device store.
  useEffect(() => {
    if (unreadable) {
      console.warn('[web-shell] this host could not be read from the app store')
      reportShellFailure('host-profile-unreadable')
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
  if (state.kind !== 'ready') {
    return (
      <ShellStateScreen
        hostId={hostId}
        state={state}
        onRetry={() => {
          if (unreadable) {
            retryHostSnapshot()
          }
          retry()
        }}
        downloadProgress={downloadProgress}
        host={snapshot?.host ?? null}
      />
    )
  }
  return (
    <View
      ref={pageFold.rootRef}
      onLayout={pageFold.onRootLayout}
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
        onLayout={pageFold.onShellLayout}
        generationDirectory={state.generationDirectory}
        sessionId={state.sessionId}
        bridgeEnabled={bridge.bridgeEnabled}
        onBridgeMessage={bridge.onBridgeMessage}
        backEdgeSwipe={backClaimed}
        onBackEdgeSwipe={bridge.sendBack}
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
            reportShellFailure(parsed.reason, parsed.reclaimed === true)
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

const styles = themedStyleSheet(() => ({
  shellRoot: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  shellView: { flex: 1 },
  unpaintedOverlay: { opacity: 0 }
}))
