import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ProtocolBlockScreen } from '../components/ProtocolBlockScreen'
import { SideSafeArea } from '../layout/side-safe-area'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostDisplaySource } from '../transport/use-host-display'
import type { DownloadProgressFeed } from './download-progress-feed'
import type {
  MobileWebShellFailureCause,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'
import { PageRouteUnavailableScreen } from './PageRouteUnavailableScreen'
import { ShellDownloadProgress } from './ShellDownloadProgress'
import { SHELL_OPENING_LABEL, ShellWaitingFrame } from './ShellWaitingFrame'

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
  useMobileColorScheme()
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

function StateView({
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
            Connect to this host to download the latest app
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
            label={state.kind === 'activating' ? SHELL_OPENING_LABEL : 'Checking host'}
          />
        </Centered>
      )
  }
}

// What the shell shows natively until the page is ready; only the page draws in a released Duo rail, so these pad it.
export function ShellStateScreen(props: Parameters<typeof StateView>[0]) {
  return (
    <SideSafeArea>
      <StateView {...props} />
    </SideSafeArea>
  )
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
}))
