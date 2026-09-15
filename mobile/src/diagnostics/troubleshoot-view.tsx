import { useCallback, useState } from 'react'
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
import { colors, spacing } from '../theme/mobile-theme'
import { troubleshootCommonIssues } from './troubleshoot-common-issues'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
export type DiagnosticStatus = 'idle' | 'running' | 'done'

export type CheckResult = {
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

function StatusIcon({ status }: { status: CheckResult['status'] }) {
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
  runDiagnostics,
  onBack,
  onConnectionLog
}: {
  rootRef?: (node: View | null) => void
  diagnosticStatus: DiagnosticStatus
  checks: CheckResult[]
  runDiagnostics: () => void
  onBack: () => void
  onConnectionLog: () => void
}) {
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
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Troubleshooting</Text>
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
              ? 'Running…'
              : diagnosticStatus === 'done'
                ? 'Run again'
                : 'Run diagnostics'}
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
          <Text style={styles.diagnosticButtonLabel}>View network diagnostics</Text>
        </Pressable>

        {checks.length > 0 && (
          <View style={styles.section}>
            {checks.map((check, i) => (
              <View key={i}>
                {i > 0 && <View style={styles.separator} />}
                <View style={styles.checkRow}>
                  <StatusIcon status={check.status} />
                  <Text style={styles.checkLabel}>{check.label}</Text>
                  <Text
                    style={[styles.checkDetail, check.status === 'fail' && styles.checkDetailFail]}
                  >
                    {check.detail}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionHeading}>Common issues</Text>

        <View style={styles.section}>
          {troubleshootCommonIssues.map((section, i) => (
            <View key={section.id}>
              {i > 0 && <View style={styles.separator} />}
              <Pressable
                style={({ pressed }) => [styles.accordionHeader, pressed && styles.rowPressed]}
                onPress={() => toggleSection(section.id)}
              >
                {section.icon}
                <Text style={styles.accordionTitle}>{section.title}</Text>
                {expandedId === section.id ? (
                  <ChevronUp size={16} color={colors.textMuted} />
                ) : (
                  <ChevronDown size={16} color={colors.textMuted} />
                )}
              </Pressable>
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
        </View>

        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </View>
  )
}
