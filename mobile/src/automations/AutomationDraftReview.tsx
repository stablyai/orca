import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import { AutomationMetadata } from './AutomationControls'
import type { AutomationDraft } from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'
import { formatAutomationSchedule } from './automation-schedule-label'
import { automationStyles as styles } from './automation-styles'

export function AutomationDraftReview({
  draft,
  setup,
  workspaces
}: {
  draft: AutomationDraft
  setup: AutomationTargets['setups'][number] | undefined
  workspaces: AutomationTargets['workspaces']
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{draft.name}</Text>
      <AutomationMetadata
        label={t('automations.mobile.instructions', 'Instructions')}
        value={draft.prompt}
      />
      <AutomationMetadata
        label={t('automations.mobile.agent', 'Agent')}
        value={
          draft.agentId
            ? MOBILE_TUI_AGENT_LABELS[draft.agentId]
            : t('automations.mobile.chooseAnAgent', 'Choose an agent')
        }
      />
      <AutomationMetadata
        label={t('automations.mobile.project', 'Project')}
        value={
          setup
            ? `${setup.label} · ${setup.path}`
            : t('automations.mobile.savedTarget', 'Saved target')
        }
      />
      <AutomationMetadata
        label={t('automations.mobile.workspace', 'Workspace')}
        value={
          draft.workspaceMode === 'existing'
            ? (workspaces.find((entry) => entry.worktreeId === draft.workspaceId)?.displayName ??
              draft.workspaceId)
            : t('automations.mobile.newWorkspacePerRun', 'New workspace per run')
        }
      />
      <AutomationMetadata
        label={t('automations.mobile.schedule', 'Schedule')}
        value={`${formatAutomationSchedule(draft.rrule)} · ${draft.timezone}`}
      />
    </View>
  )
}
