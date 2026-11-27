import { useRef, useState } from 'react'
import { View, Text, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, Copy, Ellipsis, Send } from 'lucide-react-native'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ConnectionLog } from '../components/host-connection/ConnectionLog'
import { ListRow } from '../components/list/ListGroup'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { NavBarTitleButton } from '../components/nav-bar/NavBar'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { PickerModal } from '../components/sheets/PickerModal'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'
import type { ConnectionLogEntry } from './connection/connection-log-types'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { ConnectionDiagnosis } from './connection-diagnostics-analysis'
import type { DiagnosticsSubmissionState } from './connection-diagnostics-screen-data'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  SettingsNavBar,
  SettingsSection,
  settingsScreenStyles
} from '../settings/settings-screen-frame'

function stateLabel(t: Translate, state: ConnectionState): string {
  switch (state) {
    case 'connecting':
      return t('diagnostics.connectionDiagnosticsView.status.connecting', 'Connecting')
    case 'handshaking':
      return t(
        'diagnostics.connectionDiagnosticsView.status.handshaking',
        'Securing the connection'
      )
    case 'connected':
      return t('diagnostics.connectionDiagnosticsView.status.connected', 'Connected')
    case 'disconnected':
      return t('diagnostics.connectionDiagnosticsView.status.disconnected', 'Not connected')
    case 'reconnecting':
      return t('diagnostics.connectionDiagnosticsView.status.reconnecting', 'Reconnecting')
    case 'auth-failed':
      return t('diagnostics.connectionDiagnosticsView.status.authFailed', 'Needs pairing again')
  }
}

function sendLabel(t: Translate, state: DiagnosticsSubmissionState | 'idle'): string {
  switch (state) {
    case 'sending':
      return t('diagnostics.connectionDiagnosticsView.sending', 'Sending…')
    case 'sent':
      return t('diagnostics.connectionDiagnosticsView.sent', 'Diagnostics sent')
    case 'failed':
      return t('diagnostics.connectionDiagnosticsView.retrySending', 'Retry sending')
    case 'idle':
      return t('diagnostics.connectionDiagnosticsView.sendReport', 'Send report to Orca')
  }
}

export function ConnectionDiagnosticsView({
  hosts,
  selectedHostId,
  onSelectHost,
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
  /** Paired computers; with more than one, the title picks which log shows. */
  hosts?: readonly { id: string; name: string }[]
  selectedHostId?: string | null
  onSelectHost?: (hostId: string) => void
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
  const menuAnchor = useRef<HostInstance>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hostPickerOpen, setHostPickerOpen] = useState(false)
  const title = t('diagnostics.connectionDiagnosticsView.connectionLog', 'Connection log')
  const canPickHost = hosts !== undefined && hosts.length > 1 && onSelectHost !== undefined
  const status =
    reconnectAttempts > 0
      ? t(
          'diagnostics.connectionDiagnosticsView.stateWithAttempt',
          '{{state}} · attempt {{attempts}}',
          { state: stateLabel(t, state), attempts: reconnectAttempts }
        )
      : stateLabel(t, state)
  const canSend = diagnosis?.reportability === 'orca-relay'
  return (
    <View style={[settingsScreenStyles.container, { paddingTop: insets.top }]}>
      <SettingsNavBar
        title={title}
        center={
          canPickHost ? (
            <NavBarTitleButton
              title={title}
              subtitle={hostName}
              accessibilityLabel={t(
                'diagnostics.connectionDiagnosticsView.pickComputer',
                'Connection log for {{name}}, choose computer',
                { name: hostName }
              )}
              onPress={() => setHostPickerOpen(true)}
            />
          ) : undefined
        }
        onBack={onBack}
        trailing={
          // The app's own log copies even before a computer is paired, when it matters most.
          hasHost || entries.length > 0 ? (
            <NavBarButton
              ref={menuAnchor}
              icon={Ellipsis}
              accessibilityLabel={t('diagnostics.connectionDiagnosticsView.more', 'More actions')}
              onPress={() => setMenuOpen(true)}
            />
          ) : undefined
        }
      />

      <View
        style={[
          settingsScreenStyles.scrollContent,
          styles.content,
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
      >
        {hasHost || entries.length > 0 ? (
          <>
            <SettingsSection first>
              <ListRow
                key="status"
                title={
                  !hasHost
                    ? t('diagnostics.connectionDiagnosticsView.noHosts', 'No paired hosts.')
                    : canPickHost
                      ? status
                      : hostName
                }
                subtitle={hasHost && !canPickHost ? status : undefined}
              />
              {diagnosis ? (
                <ListRow
                  key="diagnosis"
                  title={diagnosis.likelyCause}
                  wrapTitle
                  subtitle={diagnosis.nextStep}
                  subtitleLines={4}
                />
              ) : null}
            </SettingsSection>
            <View style={styles.log}>
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
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>
            {t('diagnostics.connectionDiagnosticsView.noHosts', 'No paired hosts.')}
          </Text>
        )}
      </View>

      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[
          [
            {
              id: 'copy',
              label: copied
                ? t('common.copied', 'Copied')
                : t('diagnostics.connectionDiagnosticsView.copyReport', 'Copy report'),
              icon: copied ? Check : Copy,
              onPress: () => void copyDiagnostics()
            },
            ...(canSend
              ? [
                  {
                    id: 'send',
                    label: sendLabel(t, submissionState),
                    icon: submissionState === 'sent' ? Check : Send,
                    hint: t(
                      'diagnostics.connectionDiagnosticsView.sendHint',
                      'Redacted: never terminal contents or credentials.'
                    ),
                    disabled: submissionState === 'sending' || submissionState === 'sent',
                    onPress: () => void sendDiagnostics()
                  }
                ]
              : [])
          ]
        ]}
      />
      {canPickHost ? (
        <PickerModal
          visible={hostPickerOpen}
          title={title}
          options={hosts.map((host) => ({ value: host.id, label: host.name }))}
          selected={selectedHostId ?? ''}
          onSelect={(id) => onSelectHost(id)}
          onClose={() => setHostPickerOpen(false)}
        />
      ) : null}
    </View>
  )
}
