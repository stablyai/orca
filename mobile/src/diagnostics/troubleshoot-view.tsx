import type { ReactNode } from 'react'
import { View, ScrollView, ActivityIndicator, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CheckCircle2, RefreshCw, XCircle, AlertTriangle } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { troubleshootCommonIssues } from './troubleshoot-common-issues'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  SettingsNavBar,
  SettingsSection,
  settingsScreenStyles
} from '../settings/settings-screen-frame'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
export type DiagnosticStatus = 'idle' | 'running' | 'done'

export type CheckResult = {
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

function StatusIcon({ status }: { status: CheckResult['status'] }) {
  useMobileColorScheme()
  switch (status) {
    case 'pass':
      return <CheckCircle2 size={18} color={colors.statusGreen} />
    case 'fail':
      return <XCircle size={18} color={colors.statusRed} />
    case 'warn':
      return <AlertTriangle size={18} color={colors.textMuted} />
  }
}

export function TroubleshootView({
  rootRef,
  diagnosticStatus,
  checks,
  hostEndpoints,
  runDiagnostics,
  onBack,
  onConnectionLog,
  onIssue,
  developerRow
}: {
  rootRef?: (node: HostInstance | null) => void
  diagnosticStatus: DiagnosticStatus
  checks: CheckResult[]
  hostEndpoints: readonly string[]
  runDiagnostics: () => void
  onBack: () => void
  onConnectionLog: () => void
  /** Opens a common issue's own page of steps. */
  onIssue: (id: string) => void
  /** Developer and shell rows the route fills in. */
  developerRow?: ReactNode
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const problems = checks.filter((check) => check.status === 'fail').length
  const summary =
    diagnosticStatus !== 'done'
      ? undefined
      : problems === 0
        ? t('diagnostics.troubleshootView.allGood', 'All good')
        : problems === 1
          ? t('diagnostics.troubleshootView.problems_one', '{{count}} problem', { count: problems })
          : t('diagnostics.troubleshootView.problems_other', '{{count}} problems', {
              count: problems
            })
  const running = diagnosticStatus === 'running'
  return (
    <View ref={rootRef} style={[settingsScreenStyles.container, { paddingTop: insets.top }]}>
      <SettingsNavBar
        title={t('diagnostics.troubleshootView.title', 'Troubleshooting')}
        onBack={onBack}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          settingsScreenStyles.scrollContent,
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SettingsSection first title={summary} separatorInset={LIST_LEADING_INSET}>
          {checks.map((check) => (
            <ListRow
              key={check.label}
              title={check.label}
              subtitle={check.detail}
              subtitleColor={check.status === 'fail' ? colors.statusRed : undefined}
              leading={<StatusIcon status={check.status} />}
            />
          ))}
          <ListRow
            key="run"
            title={
              diagnosticStatus === 'idle'
                ? t('diagnostics.troubleshootView.runCheck', 'Run check')
                : t('diagnostics.troubleshootView.checkAgain', 'Check again')
            }
            accent
            busy={running}
            testID="diagnostics-run"
            leading={<RefreshCw size={18} color={colors.accentBlue} strokeWidth={2.2} />}
            accessory={
              running ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined
            }
            onPress={runDiagnostics}
          />
        </SettingsSection>

        <SettingsSection>
          <ListRow
            key="log"
            title={t('diagnostics.troubleshootView.connectionLog', 'Connection log')}
            navigates
            onPress={onConnectionLog}
          />
        </SettingsSection>

        {developerRow}

        <SettingsSection title={t('diagnostics.troubleshootView.commonIssues', 'Common issues')}>
          {troubleshootCommonIssues(t, hostEndpoints).map((issue) => (
            <ListRow
              key={issue.id}
              title={issue.title}
              navigates
              onPress={() => onIssue(issue.id)}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  )
}
