import { useCallback, useState, type ReactNode } from 'react'
import { View, Text, ScrollView, ActivityIndicator, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ChevronDown,
  ChevronUp,
  Activity,
  CheckCircle2,
  ScrollText,
  XCircle,
  AlertTriangle
} from '../components/icons/app-icons'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { troubleshootCommonIssues } from './troubleshoot-common-issues'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { NATIVE_SCREEN_HEADER } from '../components/nav-bar/ScreenHeader'
import { SettingsNavBar, settingsScreenStyles } from '../settings/settings-screen-frame'
import {
  GroupedListScreen,
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../components/list/ListGroup'
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
      return <CheckCircle2 size={14} color={colors.statusGreen} />
    case 'fail':
      return <XCircle size={14} color={colors.statusRed} />
    case 'warn':
      return <AlertTriangle size={14} color={colors.textMuted} />
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
  developerRow
}: {
  rootRef?: (node: HostInstance | null) => void
  diagnosticStatus: DiagnosticStatus
  checks: CheckResult[]
  hostEndpoints: readonly string[]
  runDiagnostics: () => void
  onBack: () => void
  onConnectionLog: () => void
  /** Developer and shell rows the route fills in. */
  developerRow?: ReactNode
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const toggleSection = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  )
  return (
    <View
      ref={rootRef}
      style={[
        settingsScreenStyles.groupedContainer,
        { paddingTop: NATIVE_SCREEN_HEADER ? 0 : insets.top }
      ]}
    >
      <SettingsNavBar
        title={t('diagnostics.troubleshootView.title', 'Troubleshooting')}
        onBack={onBack}
      />

      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          settingsScreenStyles.scrollContent,
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
        showsVerticalScrollIndicator={false}
      >
        <GroupedListScreen>
          <ListGroup style={styles.group} separatorInset={LIST_LEADING_INSET}>
            <ListRow
              key="run"
              title={
                diagnosticStatus === 'running'
                  ? t('diagnostics.troubleshootView.running', 'Running…')
                  : diagnosticStatus === 'done'
                    ? t('diagnostics.troubleshootView.runAgain', 'Run again')
                    : t('diagnostics.troubleshootView.runDiagnostics', 'Run diagnostics')
              }
              leading={
                diagnosticStatus === 'running' ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Activity size={18} color={colors.textSecondary} />
                )
              }
              busy={diagnosticStatus === 'running'}
              testID="diagnostics-run"
              onPress={runDiagnostics}
            />
            <ListRow
              key="network"
              title={t(
                'diagnostics.troubleshootView.viewNetworkDiagnostics',
                'View network diagnostics'
              )}
              leading={<ScrollText size={18} color={colors.textSecondary} />}
              navigates
              onPress={onConnectionLog}
            />
          </ListGroup>

          {developerRow}

          {checks.length > 0 && (
            <ListGroup style={styles.group} separatorInset={LIST_LEADING_INSET}>
              {checks.map((check) => (
                <ListRow
                  key={check.label}
                  title={check.label}
                  leading={<StatusIcon status={check.status} />}
                  detail={
                    <Text
                      style={[
                        styles.checkDetail,
                        check.status === 'fail' && styles.checkDetailFail
                      ]}
                    >
                      {check.detail}
                    </Text>
                  }
                />
              ))}
            </ListGroup>
          )}

          <SectionHeader
            title={t('diagnostics.troubleshootView.commonIssues', 'Common issues')}
            first
          />

          <ListGroup style={styles.group} separatorInset={LIST_LEADING_INSET}>
            {troubleshootCommonIssues(t, hostEndpoints).map((section) => (
              <View key={section.id}>
                <ListRow
                  title={section.title}
                  leading={<section.icon size={18} color={colors.textSecondary} />}
                  accessory={
                    expandedId === section.id ? (
                      <ChevronUp size={16} color={colors.disclosureTint} />
                    ) : (
                      <ChevronDown size={16} color={colors.disclosureTint} />
                    )
                  }
                  onPress={() => toggleSection(section.id)}
                />
                {expandedId === section.id && (
                  <View style={styles.accordionBody}>
                    {section.steps.map((step, j) => (
                      <View key={j} style={styles.stepRow}>
                        <Text style={styles.bullet}>•</Text>
                        <Text style={styles.stepText}>{step}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </ListGroup>
        </GroupedListScreen>
      </ScrollView>
    </View>
  )
}
