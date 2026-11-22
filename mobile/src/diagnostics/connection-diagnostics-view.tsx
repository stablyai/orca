import type { ReactNode } from 'react'
import { View, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, Copy, Check, Send } from '../components/icons/app-icons'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ConnectionLog } from '../components/host-connection/ConnectionLog'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'
import type { ConnectionLogEntry } from './connection/connection-log-types'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { ConnectionDiagnosis } from './connection-diagnostics-analysis'
import type { DiagnosticsSubmissionState } from './connection-diagnostics-screen-data'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { NATIVE_SCREEN_HEADER } from '../components/nav-bar/ScreenHeader'
import {
  SettingsNavBar,
  SettingsNote,
  settingsScreenStyles
} from '../settings/settings-screen-frame'
import {
  GroupedListScreen,
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../components/list/ListGroup'

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
    <View
      style={[
        settingsScreenStyles.groupedContainer,
        { paddingTop: NATIVE_SCREEN_HEADER ? 0 : insets.top }
      ]}
    >
      <SettingsNavBar
        title={t('diagnostics.connectionDiagnosticsView.title', 'Network diagnostics')}
        onBack={onBack}
      />

      <View
        style={[
          settingsScreenStyles.scrollContent,
          styles.content,
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
      >
        <GroupedListScreen>
          {hostPicker}
          {hasHost || entries.length > 0 ? (
            <>
              <ListGroup style={styles.group} separatorInset={LIST_LEADING_INSET}>
                <ListRow
                  key="state"
                  title={
                    !hasHost
                      ? t('diagnostics.connectionDiagnosticsView.noHosts', 'No paired hosts.')
                      : reconnectAttempts > 0
                        ? t(
                            'diagnostics.connectionDiagnosticsView.stateWithAttempt',
                            '{{state}} · attempt {{attempts}}',
                            { state: stateLabels[state], attempts: reconnectAttempts }
                          )
                        : stateLabels[state]
                  }
                  leading={<Activity size={18} color={colors.textSecondary} />}
                />
                <ListRow
                  key="copy"
                  title={
                    copied
                      ? t('common.copied', 'Copied')
                      : t('diagnostics.connectionDiagnosticsView.copyReport', 'Copy report')
                  }
                  leading={
                    copied ? (
                      <Check size={18} color={colors.statusGreen} />
                    ) : (
                      <Copy size={18} color={colors.textSecondary} />
                    )
                  }
                  onPress={() => void copyDiagnostics()}
                />
              </ListGroup>
              {diagnosis && (
                <View style={styles.group}>
                  <SectionHeader
                    title={t(
                      'diagnostics.connectionDiagnosticsView.diagnosisHeading',
                      'What this suggests'
                    )}
                    first
                  />
                  <ListGroup separatorInset={LIST_LEADING_INSET}>
                    <ListRow
                      key="diagnosis"
                      title={diagnosis.likelyCause}
                      wrapTitle
                      subtitle={diagnosis.nextStep}
                      subtitleLines={0}
                    />
                    {diagnosis.reportability === 'orca-relay' ? (
                      <ListRow
                        key="send"
                        title={
                          submissionState === 'sending'
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
                                    'Send diagnostics'
                                  )
                        }
                        leading={
                          submissionState === 'sent' ? (
                            <Check size={18} color={colors.statusGreen} />
                          ) : (
                            <Send size={18} color={colors.textSecondary} />
                          )
                        }
                        busy={submissionState === 'sending'}
                        onPress={() => void sendDiagnostics()}
                      />
                    ) : null}
                  </ListGroup>
                  {diagnosis.reportability === 'orca-relay' ? (
                    <SettingsNote>
                      {t(
                        'diagnostics.connectionDiagnosticsView.privacyHint',
                        'Sends a size-limited redacted report including host name, endpoint, versions, connection state, and events—never terminal contents or credentials.'
                      )}
                    </SettingsNote>
                  ) : null}
                </View>
              )}
              {entries.length > 0 ? (
                <ConnectionLog
                  entries={[...entries]}
                  title={hostName}
                  fillAvailableHeight
                  style={styles.log}
                />
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
        </GroupedListScreen>
      </View>
    </View>
  )
}
