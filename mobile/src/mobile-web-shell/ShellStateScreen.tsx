import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ProtocolBlockScreen } from '../components/ProtocolBlockScreen'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostDisplaySource } from '../transport/use-host-display'
import type { DownloadProgressFeed } from './download-progress-feed'
import type {
  MobileWebShellFailureCause,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'
import { ShellDownloadProgress } from './ShellDownloadProgress'
import { ShellWaitingFrame } from './ShellWaitingFrame'

function failureMessage(reason: MobileWebShellFailureCause, t: Translate): string {
  switch (reason) {
    case 'isolation-unavailable':
      return t(
        'webShell.shellStateScreen.isolationUnavailable',
        "This device's WebView is too old to open the workspace safely."
      )
    case 'download-failed':
      return t(
        'webShell.shellStateScreen.downloadFailed',
        'The latest app could not be downloaded from this host.'
      )
    case 'host-profile-unreadable':
      return t(
        'webShell.shellStateScreen.hostProfileUnreadable',
        'Could not read this host on your device. Try again.'
      )
    case 'status-unreadable':
      return t(
        'webShell.shellStateScreen.statusUnreadable',
        "Could not read this host's status. Go back and reopen it."
      )
    case 'render-process-gone':
      return t('webShell.shellStateScreen.renderProcessGone', 'The workspace stopped responding.')
    case 'generation-unreadable':
    case 'document-load-failed':
      return t(
        'webShell.shellStateScreen.documentLoadFailed',
        'The downloaded app could not be opened.'
      )
  }
}

function Centered({ children }: { children: ReactNode }) {
  useMobileColorScheme()
  return <View style={styles.centered}>{children}</View>
}

function Failed({
  state,
  onRetry
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'failed' }>
  onRetry: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Retry cannot change a settled isolation gate or give an unsupported WebView the missing fence.
  const retryable = state.reason !== 'isolation-unavailable' && state.reason !== 'status-unreadable'
  return (
    <Centered>
      <Text style={styles.failedMessage} testID="mobile-web-shell-failed">
        {failureMessage(state.reason, t)}
      </Text>
      {retryable ? (
        <Pressable
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          testID="mobile-web-shell-retry"
          onPress={onRetry}
        >
          <Text style={styles.retryLabel}>
            {t('webShell.shellStateScreen.tryAgain', 'Try again')}
          </Text>
        </Pressable>
      ) : null}
    </Centered>
  )
}

// What the shell shows natively until its page is ready.
export function ShellStateScreen({
  hostId,
  state,
  onRetry,
  downloadProgress,
  host
}: {
  hostId: string
  state: Exclude<MobileWebShellSessionState, { kind: 'ready' }>
  onRetry: () => void
  downloadProgress: DownloadProgressFeed
  host: HostDisplaySource | null
}) {
  const t = useMobileTranslation()
  switch (state.kind) {
    case 'route-unavailable':
      return <PageRouteUnavailableScreen hostId={hostId} />
    case 'wall':
      return <ProtocolBlockScreen verdict={state.verdict} />
    case 'failed':
      return <Failed state={state} onRetry={onRetry} />
    case 'offline':
      return (
        <Centered>
          <Text style={styles.waitingLabel} testID="mobile-web-shell-offline">
            {t(
              'webShell.shellStateScreen.connectToDownload',
              'Connect to this host to download the latest app'
            )}
          </Text>
        </Centered>
      )
    case 'fetching':
      return (
        <Centered>
          <ShellDownloadProgress state={state} feed={downloadProgress} host={host} />
        </Centered>
      )
    case 'checking':
    case 'activating':
      return (
        <Centered>
          <ShellWaitingFrame
            label={
              state.kind === 'activating'
                ? t('webShell.shellStateScreen.openingWorkspace', 'Opening workspace')
                : t('webShell.shellStateScreen.checkingHost', 'Checking host')
            }
          />
        </Centered>
      )
  }
}

const styles = themedStyleSheet(() => ({
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
    borderRadius: radii.control
  },
  retryLabel: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  pressed: {
    opacity: 0.7
  }
}))
