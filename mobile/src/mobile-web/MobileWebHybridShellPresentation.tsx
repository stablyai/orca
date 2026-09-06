import type { RefObject } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  MobileWebShellView,
  type MobileWebShellSession,
  type MobileWebShellViewRef
} from '@orca/expo-mobile-web-shell'
import { ChevronLeft, MonitorSmartphone } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'
import { hybridShellStyles as styles } from './hybrid-shell-styles'
import { MobileWebRecoveryActions } from './MobileWebRecoveryActions'
import { MobileWebPackageProgress } from './MobileWebPackageProgress'
import {
  mobileWebShellPresentationState,
  mobileWebShellShowsNativeChrome
} from './mobile-web-shell-presentation-state'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'
import { mobileWebShellHostName, type MobileWebShellNotice } from './mobile-web-shell-notice'

type MobileWebHybridShellPresentationProps = {
  viewRef: RefObject<MobileWebShellViewRef | null>
  selectedHost: HostProfile | undefined
  session: MobileWebShellSession | null
  viewEpoch: number
  packageLoading: boolean
  packageProgress: MobileWebPackageDownloadProgress | undefined
  packageWarning: MobileWebShellNotice | undefined
  hostedViewActive: boolean
  onBack: () => void
  onShowHosts: () => void
  onRetryRecovery: () => void | Promise<void>
  onUsePrevious: () => void | Promise<void>
  onClearCache: () => void | Promise<void>
  onRecoveryFailure: () => void
  onBridgeMessage: (message: string) => void
  onDocumentLoadStarted: () => void
  onPageLoaded: () => void
  onLoadFailed: (reason: string | undefined) => void
  onNavigationBlocked: () => void
  onProcessTerminated: (sessionId: string) => void
}

export function MobileWebHybridShellPresentation({
  viewRef,
  selectedHost,
  session,
  viewEpoch,
  packageLoading,
  packageProgress,
  packageWarning,
  hostedViewActive,
  onBack,
  onShowHosts,
  onRetryRecovery,
  onUsePrevious,
  onClearCache,
  onRecoveryFailure,
  onBridgeMessage,
  onDocumentLoadStarted,
  onPageLoaded,
  onLoadFailed,
  onNavigationBlocked,
  onProcessTerminated
}: MobileWebHybridShellPresentationProps) {
  const insets = useSafeAreaInsets()
  const presentationState = mobileWebShellPresentationState({
    hasSelectedHost: Boolean(selectedHost),
    hasSession: Boolean(session),
    packageLoading
  })
  const showNativeChrome = mobileWebShellShowsNativeChrome(presentationState)
  // The notice already reads as a full sentence, so it replaces the generic status line.
  const statusLine =
    packageWarning?.message ??
    (presentationState === 'package-loading'
      ? selectedHost
        ? `Connecting to ${mobileWebShellHostName(selectedHost.name)}…`
        : 'Getting things ready…'
      : `Couldn’t connect to ${mobileWebShellHostName(selectedHost?.name)}.`)

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {showNativeChrome ? (
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={8}
            style={styles.headerButton}
            onPress={onBack}
          >
            <ChevronLeft size={22} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.heading}>
              {selectedHost?.name ?? 'Orca'}
            </Text>
          </View>
          {selectedHost ? (
            <Pressable
              accessibilityLabel="Show paired hosts"
              accessibilityRole="button"
              style={styles.hostsButton}
              onPress={onShowHosts}
            >
              <Text style={styles.hostsButtonText}>Hosts</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {presentationState === 'hosted-interface' && session ? (
        <View style={styles.webContainer}>
          {packageLoading && packageProgress ? (
            <View style={styles.packageProgressBanner}>
              <MobileWebPackageProgress progress={packageProgress} />
            </View>
          ) : null}
          {packageWarning ? (
            <View style={styles.noticeBanner}>
              <Text accessibilityRole="alert" style={styles.noticeBannerText}>
                {packageWarning.message}
              </Text>
              {packageWarning.code ? (
                <Text style={styles.noticeCode}>Error: {packageWarning.code}</Text>
              ) : null}
              <MobileWebRecoveryActions
                canUsePrevious
                align="start"
                onClearCache={onClearCache}
                onFailure={onRecoveryFailure}
                onRetry={onRetryRecovery}
                onShowHosts={onShowHosts}
                onUsePrevious={onUsePrevious}
              />
            </View>
          ) : null}
          <MobileWebShellView
            key={`${session.sessionId}:${viewEpoch}`}
            ref={viewRef}
            sessionId={hostedViewActive ? session.sessionId : null}
            onBridgeMessage={(event) => onBridgeMessage(event.nativeEvent.data)}
            onLoadState={(event) => {
              // A load only ever starts because the document is being replaced, and the outgoing
              // page's grants have to retire before the incoming one initializes.
              if (event.nativeEvent.state === 'loading') {
                onDocumentLoadStarted()
                return
              }
              if (event.nativeEvent.state === 'loaded') {
                onPageLoaded()
                return
              }
              if (event.nativeEvent.state === 'failed') {
                onLoadFailed(event.nativeEvent.reason)
              }
            }}
            onNavigationBlocked={onNavigationBlocked}
            onProcessTerminated={(event) => onProcessTerminated(event.nativeEvent.sessionId)}
            style={styles.webView}
          />
        </View>
      ) : (
        <View style={styles.loadingState}>
          {packageLoading ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <MonitorSmartphone size={26} color={colors.textMuted} />
          )}
          {packageLoading && packageProgress ? (
            <MobileWebPackageProgress progress={packageProgress} />
          ) : (
            <Text
              accessibilityLiveRegion="polite"
              accessibilityRole={packageWarning ? 'alert' : undefined}
              style={styles.loadingTitle}
            >
              {statusLine}
            </Text>
          )}
          {packageWarning?.code ? (
            <Text style={styles.noticeCode}>Error: {packageWarning.code}</Text>
          ) : null}
          {packageWarning ? (
            <MobileWebRecoveryActions
              canUsePrevious={false}
              onClearCache={onClearCache}
              onFailure={onRecoveryFailure}
              onRetry={onRetryRecovery}
              onShowHosts={onShowHosts}
              onUsePrevious={onUsePrevious}
            />
          ) : null}
        </View>
      )}
    </View>
  )
}
