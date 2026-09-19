import { useEffect, type ReactNode } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  OrcaMobileWebShellView,
  parseMobileWebShellLoadState
} from '../../modules/orca-mobile-web-shell/src'
import { ProtocolBlockScreen } from '../components/ProtocolBlockScreen'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { BridgeInitRoute } from './bridge/bridge-envelope'
import type {
  MobileWebShellFailureCause,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'
import { useMobileWebShellBridge } from './use-mobile-web-shell-bridge'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { useShellStackPop } from './use-shell-stack-pop'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'
import { usePageHostSnapshot } from './use-page-host-snapshot'

// Same guard as the Troubleshoot developer row: `__DEV__` is undefined outside the React Native
// runtime, and the facts below are for whoever is bringing the shell up, not for a user.
const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__

/** Enough of a build id to tell two generations apart in a screenshot, and not enough to be one. */
const BUILD_ID_PREFIX_LENGTH = 12

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

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}

function Waiting({ label }: { label: string }) {
  return (
    <Centered>
      <ActivityIndicator color={colors.textSecondary} accessibilityLabel={label} />
      <Text style={styles.waitingLabel}>{label}</Text>
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

/** Never the generation directory, never the whole build id, never the host id: this renders on a
 *  device someone may be screen-sharing, and none of those three tell them anything a prefix does
 *  not. */
function DevFacts({ state }: { state: Extract<MobileWebShellSessionState, { kind: 'ready' }> }) {
  if (!isDevelopmentBuild) {
    return null
  }
  return (
    <View style={styles.devFacts} pointerEvents="none">
      <Text style={styles.devFactsText} testID="mobile-web-shell-dev-facts">
        {`${state.buildId.slice(0, BUILD_ID_PREFIX_LENGTH)} · ${state.totalBytes} B · ${state.elapsedMs} ms`}
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
  runtime
}: MobileWebShellScreenProps) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const popShellStack = useShellStackPop()
  const { state, pageRoutes, retry, reportShellFailure, reportDocumentLoaded, reportPageReady } =
    useMobileWebShellSession({ hostId, routePathname: route.pathname, runtime })
  const { snapshot, unreadable, readStorage, refreshStorage, writeStorage } =
    usePageHostSnapshot(hostId)
  const bridge = useMobileWebShellBridge({
    hostId,
    route,
    pageRoutes,
    session: state,
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
    onPageReady: () => {
      reportPageReady()
      void refreshStorage()
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
    // Straight to the system handler. The envelope allowlisted the scheme before this ran, so the
    // only failure left is a device with nothing registered for it — a `mailto:` on a phone with no
    // mail account. Reported rather than swallowed: nothing crosses back for a notify, so this is
    // the one dead tap the verb does not rule out, and silence is what would hide it. Still not
    // rethrown, because this runs on the native frame handler.
    onExternalLink: (url: string) => {
      void Linking.openURL(url).catch((error: unknown) => {
        console.warn('[web-shell] could not open a URL for the page', { url, error })
      })
    },
    // The page's own Back goes nowhere: it holds the one history entry the entry wrote, so the only
    // stack to pop is this one.
    onNavigateBack: popShellStack
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
    return <Waiting label={state.kind === 'activating' ? 'Opening workspace' : 'Checking host'} />
  }
  return (
    <View
      style={[styles.shellRoot, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="mobile-web-shell-ready"
    >
      <OrcaMobileWebShellView
        key={state.sessionId}
        ref={bridge.viewRef}
        style={styles.shellView}
        generationDirectory={state.generationDirectory}
        sessionId={state.sessionId}
        bridgeEnabled={bridge.bridgeEnabled}
        onBridgeMessage={bridge.onBridgeMessage}
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
          }
        }}
      />
      <DevFacts state={state} />
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
