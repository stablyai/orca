import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { Switch, Text, View } from 'react-native'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { AutomationChoice, AutomationField } from './AutomationControls'
import type { AutomationDraft } from './automation-draft'
import { automationStyles as styles } from './automation-styles'

export function AutomationAdvancedFields({
  draft,
  change,
  disabled,
  capabilities
}: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  disabled: boolean
  capabilities: readonly string[]
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.stack}>
      {draft.workspaceMode === 'new_per_run' ? (
        <AutomationField
          label={t('automations.mobile.baseBranchOptional', 'Base branch (optional)')}
          literal
          value={draft.baseBranch}
          onChange={(baseBranch) => change({ baseBranch })}
          disabled={disabled}
        />
      ) : null}
      <AutomationChoice
        label={t('automations.mobile.workspaceSetupScript', 'Workspace setup script')}
        value={draft.setupDecision}
        options={[
          {
            value: 'inherit',
            label: t('automations.mobile.useProjectSettings', 'Use project settings')
          },
          { value: 'run', label: t('automations.mobile.runSetupScript', 'Run setup script') },
          { value: 'skip', label: t('automations.mobile.skipSetupScript', 'Skip setup script') }
        ]}
        onSelect={(setupDecision) => change({ setupDecision, setupDecisionEdited: true })}
        disabled={disabled}
      />
      {draft.workspaceMode === 'existing' ? (
        <View style={styles.row}>
          <Text style={[styles.text, styles.grow]}>
            {t('automations.mobile.reuseAgentSession', 'Reuse agent session')}
          </Text>
          <Switch
            accessibilityLabel={t('automations.mobile.reuseAgentSession', 'Reuse agent session')}
            value={draft.reuseSession}
            onValueChange={(reuseSession) => change({ reuseSession })}
            disabled={disabled}
          />
        </View>
      ) : null}
      <AutomationField
        label={t('automations.mobile.extraAgentArguments', 'Extra agent arguments')}
        literal
        value={draft.extraAgentArgs}
        onChange={(extraAgentArgs) => change({ extraAgentArgs })}
        disabled={
          disabled || !capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
        }
      />
      <AutomationField
        label={t('automations.mobile.precheckCommandOptional', 'Precheck command (optional)')}
        literal
        value={draft.precheckCommand}
        onChange={(precheckCommand) => change({ precheckCommand })}
        disabled={disabled}
      />
      {draft.precheckCommand ? (
        <AutomationField
          label={t('automations.mobile.precheckTimeoutSeconds', 'Precheck timeout (seconds)')}
          value={draft.precheckTimeout}
          onChange={(precheckTimeout) => change({ precheckTimeout })}
          numeric
          disabled={disabled}
        />
      ) : null}
      <AutomationField
        label={t('automations.mobile.missedRunGraceMinutes', 'Missed-run grace (minutes)')}
        value={draft.grace}
        onChange={(grace) => change({ grace })}
        numeric
        disabled={disabled}
      />
    </View>
  )
}
