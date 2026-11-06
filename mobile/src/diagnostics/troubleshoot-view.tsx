import { useCallback, useState, type ReactNode } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Activity,
  CheckCircle2,
  ScrollText,
  XCircle,
  AlertTriangle
} from 'lucide-react-native'
import { colors, spacing, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { troubleshootCommonIssues } from './troubleshoot-common-issues'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { LIST_LEADING_INSET, ListGroup, SectionHeader, ListRow } from '../components/list/ListGroup'
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
  rootRef?: (node: View | null) => void
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
    <View ref={rootRef} style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={({ pressed }) => [styles.backButton, pressed && pressedStyle]}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>
          {t('diagnostics.troubleshootView.title', 'Troubleshooting')}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          style={({ pressed }) => [
            styles.diagnosticButton,
            pressed && styles.diagnosticButtonPressed,
            diagnosticStatus === 'running' && styles.diagnosticButtonDisabled
          ]}
          testID="diagnostics-run"
          onPress={runDiagnostics}
          disabled={diagnosticStatus === 'running'}
        >
          {diagnosticStatus === 'running' ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Activity size={16} color={colors.textPrimary} />
          )}
          <Text style={styles.diagnosticButtonLabel}>
            {diagnosticStatus === 'running'
              ? t('diagnostics.troubleshootView.running', 'Running…')
              : diagnosticStatus === 'done'
                ? t('diagnostics.troubleshootView.runAgain', 'Run again')
                : t('diagnostics.troubleshootView.runDiagnostics', 'Run diagnostics')}
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.diagnosticButton,
            pressed && styles.diagnosticButtonPressed
          ]}
          onPress={onConnectionLog}
        >
          <ScrollText size={16} color={colors.textPrimary} />
          <Text style={styles.diagnosticButtonLabel}>
            {t('diagnostics.troubleshootView.viewNetworkDiagnostics', 'View network diagnostics')}
          </Text>
        </Pressable>

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
                    style={[styles.checkDetail, check.status === 'fail' && styles.checkDetailFail]}
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
                leading={<section.icon size={16} color={colors.textSecondary} />}
                accessory={
                  expandedId === section.id ? (
                    <ChevronUp size={16} color={colors.textMuted} />
                  ) : (
                    <ChevronDown size={16} color={colors.textMuted} />
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

        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </View>
  )
}
