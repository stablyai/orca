import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { Check, Copy, Send, ScrollText, MonitorSmartphone } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { ConnectionLog } from '../components/ConnectionLog'
import { StatusDot } from '../components/StatusDot'
import { Button } from '../components/ui/Button'
import { StateView } from '../components/ui/StateView'
import { SettingsScreen } from '../settings/settings-screen-frame'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'
import type { ConnectionLogEntry, ConnectionState } from '../transport/types'
import type { ConnectionDiagnosis } from './connection-diagnostics-analysis'
import type { DiagnosticsSubmissionState } from './connection-diagnostics-screen-data'

/** What the connection is doing, in words; the raw state stays in the copied report. */
export function connectionStatusLabel(state: ConnectionState, reconnectAttempts: number): string {
  const attempt = reconnectAttempts > 0 ? ` (attempt ${reconnectAttempts})` : ''
  switch (state) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return `Connecting${attempt}…`
    case 'handshaking':
      return 'Securing connection…'
    case 'reconnecting':
      return `Reconnecting${attempt}…`
    case 'disconnected':
      return 'Not connected'
    case 'auth-failed':
      return 'Pairing no longer valid'
  }
}

function sendLabel(state: DiagnosticsSubmissionState | 'idle'): string {
  switch (state) {
    case 'sending':
      return 'Sending…'
    case 'sent':
      return 'Diagnostics sent'
    case 'failed':
      return 'Retry sending'
    case 'idle':
      return 'Send diagnostics to Orca'
  }
}

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
  return (
    <SettingsScreen title="Network diagnostics" onBack={onBack} scrollable={false}>
      {hasHost ? (
        <View style={styles.body}>
          {hostPicker}
          <View style={styles.statusRow}>
            <StatusDot state={state} size={10} />
            <Text style={styles.statusText} numberOfLines={1} accessibilityLiveRegion="polite">
              {connectionStatusLabel(state, reconnectAttempts)}
            </Text>
            <Button
              label={copied ? 'Copied' : 'Copy report'}
              icon={copied ? Check : Copy}
              size="compact"
              onPress={() => void copyDiagnostics()}
            />
          </View>
          {diagnosis ? (
            <View style={styles.diagnosisCard}>
              <Text style={styles.diagnosisHeading}>What this suggests</Text>
              <Text style={styles.diagnosisText}>{diagnosis.likelyCause}</Text>
              <Text style={styles.diagnosisNext}>{diagnosis.nextStep}</Text>
              {diagnosis.reportability === 'orca-relay' ? (
                <>
                  <Text style={styles.privacyHint}>
                    Sends a size-limited, redacted report with the desktop name, address, versions,
                    connection state and events. Never terminal contents or credentials.
                  </Text>
                  <Button
                    label={sendLabel(submissionState)}
                    icon={submissionState === 'sent' ? Check : Send}
                    variant="primary"
                    size="compact"
                    busy={submissionState === 'sending'}
                    onPress={() => void sendDiagnostics()}
                    style={styles.sendAction}
                  />
                  {submissionState === 'failed' ? (
                    <Text style={[styles.sendResult, { color: colors.danger }]}>
                      The report could not be sent. Check your connection and try again.
                    </Text>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}
          {entries.length > 0 ? (
            <ConnectionLog entries={[...entries]} title={hostName} fillAvailableHeight />
          ) : (
            <View style={styles.empty}>
              <StateView
                icon={ScrollText}
                title="No connection events yet"
                message={`Events appear here as the app dials ${hostName || 'this desktop'}.`}
              />
            </View>
          )}
        </View>
      ) : (
        <StateView
          icon={MonitorSmartphone}
          title="No paired desktops"
          message="Pair a desktop to see its connection events here."
        />
      )}
    </SettingsScreen>
  )
}
