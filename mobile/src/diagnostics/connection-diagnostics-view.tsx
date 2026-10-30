import type { ReactNode } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, Copy, Check, Send } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ConnectionLog } from '../components/ConnectionLog'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'
import type { ConnectionLogEntry, ConnectionState } from '../transport/types'
import type { ConnectionDiagnosis } from './connection-diagnostics-analysis'
import type { DiagnosticsSubmissionState } from './connection-diagnostics-screen-data'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function ConnectionDiagnosticsView({
  hostPicker,
  hasHost,
  hostName,
  state,
  reconnectAttempts,
  copied,
  copyDiagnostics,
  diagnosis,
  submissionState,
  sendDiagnostics,
  entries,
  onBack
}: {
  hostPicker?: ReactNode
  hasHost: boolean
  hostName: string
  state: ConnectionState
  reconnectAttempts: number
  copied: boolean
  copyDiagnostics: () => Promise<void>
  diagnosis: ConnectionDiagnosis | null
  submissionState: DiagnosticsSubmissionState | 'idle'
  sendDiagnostics: () => Promise<void>
  entries: readonly ConnectionLogEntry[]
  onBack: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const stateLabels: Record<ConnectionState, string> = {
    connecting: t('diagnostics.connectionDiagnosticsView.connecting', 'connecting'),
    handshaking: t('diagnostics.connectionDiagnosticsView.handshaking', 'handshaking'),
    connected: t('diagnostics.connectionDiagnosticsView.connected', 'connected'),
    disconnected: t('diagnostics.connectionDiagnosticsView.disconnected', 'disconnected'),
    reconnecting: t('diagnostics.connectionDiagnosticsView.reconnecting', 'reconnecting'),
    'auth-failed': t('diagnostics.connectionDiagnosticsView.authFailed', 'auth-failed')
  }
  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>
          {t('diagnostics.connectionDiagnosticsView.title', 'Network diagnostics')}
        </Text>
      </View>

      {hostPicker}
      {hasHost || entries.length > 0 ? (
        <>
          <View style={styles.statusRow}>
            <Text style={styles.statusText}>
              {!hasHost
                ? t('diagnostics.connectionDiagnosticsView.noHosts', 'No paired hosts.')
                : reconnectAttempts > 0
                  ? t(
                      'diagnostics.connectionDiagnosticsView.stateWithAttempt',
                      '{{state}} · attempt {{attempts}}',
                      { state: stateLabels[state], attempts: reconnectAttempts }
                    )
                  : stateLabels[state]}
            </Text>
            <Pressable style={styles.copyButton} onPress={() => void copyDiagnostics()}>
              {copied ? (
                <Check size={14} color={colors.statusGreen} />
              ) : (
                <Copy size={14} color={colors.textSecondary} />
              )}
              <Text style={styles.copyButtonText}>
                {copied
                  ? t('common.copied', 'Copied')
                  : t('diagnostics.connectionDiagnosticsView.copyReport', 'Copy report')}
              </Text>
            </Pressable>
          </View>
          {diagnosis && (
            <View style={styles.diagnosisCard}>
              <Text style={styles.diagnosisHeading}>
                {t('diagnostics.connectionDiagnosticsView.diagnosisHeading', 'What this suggests')}
              </Text>
              <Text style={styles.diagnosisText}>{diagnosis.likelyCause}</Text>
              <Text style={styles.diagnosisNext}>{diagnosis.nextStep}</Text>
              {diagnosis.reportability === 'orca-relay' && (
                <>
                  <Text style={styles.privacyHint}>
                    {t(
                      'diagnostics.connectionDiagnosticsView.privacyHint',
                      'Sends a size-limited redacted report including host name, endpoint, versions, connection state, and events—never terminal contents or credentials.'
                    )}
                  </Text>
                  <Pressable
                    style={styles.sendButton}
                    onPress={() => void sendDiagnostics()}
                    disabled={submissionState === 'sending'}
                  >
                    {submissionState === 'sent' ? (
                      <Check size={14} color={colors.statusGreen} />
                    ) : (
                      <Send size={14} color={colors.textPrimary} />
                    )}
                    <Text style={styles.sendButtonText}>
                      {submissionState === 'sending'
                        ? t('diagnostics.connectionDiagnosticsView.sending', 'Sending…')
                        : submissionState === 'sent'
                          ? t('diagnostics.connectionDiagnosticsView.sent', 'Diagnostics sent')
                          : submissionState === 'failed'
                            ? t(
                                'diagnostics.connectionDiagnosticsView.retrySending',
                                'Retry sending'
                              )
                            : t(
                                'diagnostics.connectionDiagnosticsView.sendDiagnostics',
                                'Send diagnostics to Orca'
                              )}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
          {entries.length > 0 ? (
            <ConnectionLog entries={[...entries]} title={hostName} fillAvailableHeight />
          ) : (
            <Text style={styles.emptyText}>
              {t(
                'diagnostics.connectionDiagnosticsView.noEvents',
                'No connection events yet. Events appear as the app dials this host.'
              )}
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.emptyText}>
          {t('diagnostics.connectionDiagnosticsView.noHosts', 'No paired hosts.')}
        </Text>
      )}
    </View>
  )
}
