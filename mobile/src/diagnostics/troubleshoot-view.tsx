import { useCallback, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ScrollText,
  XCircle
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
import { triggerSelection } from '../platform/haptics'
import { SettingsRowIcon, SettingsScreen, SettingsSection } from '../settings/settings-screen-frame'
import { troubleshootCommonIssues, type TroubleshootSection } from './troubleshoot-common-issues'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'

export type DiagnosticStatus = 'idle' | 'running' | 'done'

export type CheckResult = {
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

const STATUS_WORD: Record<CheckResult['status'], string> = {
  pass: 'Passed',
  fail: 'Failed',
  warn: 'Warning'
}

function StatusIcon({ status }: { status: CheckResult['status'] }) {
  switch (status) {
    case 'pass':
      return <CheckCircle2 size={18} color={colors.statusGreen} strokeWidth={2.2} />
    case 'fail':
      return <XCircle size={18} color={colors.danger} strokeWidth={2.2} />
    case 'warn':
      return <AlertTriangle size={18} color={colors.statusAmber} strokeWidth={2.2} />
  }
}

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <View
      style={styles.checkRow}
      accessible
      accessibilityLabel={`${check.label}, ${STATUS_WORD[check.status]}, ${check.detail}`}
    >
      <View style={styles.checkIcon}>
        <StatusIcon status={check.status} />
      </View>
      <View style={styles.checkMain}>
        <Text style={styles.checkLabel}>{check.label}</Text>
        <Text style={[styles.checkDetail, check.status === 'fail' && styles.checkDetailFail]}>
          {check.detail}
        </Text>
      </View>
    </View>
  )
}

function IssueRow({
  section,
  expanded,
  onToggle
}: {
  section: TroubleshootSection
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={section.title}
        accessibilityState={{ expanded }}
        onPress={onToggle}
      >
        {({ pressed }) => (
          <View
            style={[
              styles.disclosureRow,
              pressed && styles.rowPressed,
              pressed ? pressTransition.pressed : pressTransition.rest
            ]}
          >
            <View style={styles.disclosureIcon}>
              <SettingsRowIcon icon={section.icon} />
            </View>
            <Text style={styles.disclosureTitle} numberOfLines={2}>
              {section.title}
            </Text>
            <View
              style={[expanded ? styles.chevronExpanded : styles.chevronCollapsed, slideTransition]}
            >
              <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
            </View>
          </View>
        )}
      </Pressable>
      <Collapsible open={expanded}>
        <View style={styles.disclosureBody}>
          {section.steps.map((step) => (
            <View key={step} style={styles.stepRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
      </Collapsible>
    </View>
  )
}

export function TroubleshootView({
  rootRef,
  diagnosticStatus,
  checks,
  runDiagnostics,
  onBack,
  onConnectionLog,
  developerRow
}: {
  rootRef?: (node: View | null) => void
  diagnosticStatus: DiagnosticStatus
  checks: CheckResult[]
  runDiagnostics: () => void
  onBack: () => void
  onConnectionLog: () => void
  /** Developer and shell rows the route fills in. */
  developerRow?: ReactNode
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const toggleSection = useCallback((id: string) => {
    triggerSelection()
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])
  const running = diagnosticStatus === 'running'
  return (
    <SettingsScreen title="Troubleshooting" onBack={onBack}>
      <View ref={rootRef}>
        <View style={styles.actions}>
          <Button
            label={
              running
                ? 'Running diagnostics…'
                : diagnosticStatus === 'done'
                  ? 'Run again'
                  : 'Run diagnostics'
            }
            onPress={runDiagnostics}
            variant="primary"
            icon={Activity}
            busy={running}
            block
            testID="diagnostics-run"
          />
        </View>

        {checks.length > 0 ? (
          <View style={styles.results} accessibilityLiveRegion="polite">
            <View style={styles.section}>
              {checks.map((check, index) => (
                <View key={check.label}>
                  {index > 0 ? <View style={styles.iconSeparator} /> : null}
                  <CheckRow check={check} />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <SettingsSection>
          <ListRow
            title="Network diagnostics"
            leading={<SettingsRowIcon icon={ScrollText} />}
            navigates
            onPress={onConnectionLog}
          />
        </SettingsSection>

        {developerRow ? <View style={styles.developer}>{developerRow}</View> : null}

        <SectionHeader title="Common issues" />
        <View style={styles.section}>
          {troubleshootCommonIssues.map((section, index) => (
            <View key={section.id}>
              {index > 0 ? <View style={styles.iconSeparator} /> : null}
              <IssueRow
                section={section}
                expanded={expandedId === section.id}
                onToggle={() => toggleSection(section.id)}
              />
            </View>
          ))}
        </View>
      </View>
    </SettingsScreen>
  )
}
