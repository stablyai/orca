import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSwitch } from './MobileSwitch'
import { ListGroup } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'

export function NewWorkspaceSetupScriptField({
  command,
  source,
  runPolicy,
  decision,
  runSetup,
  onDecisionChange,
  onRunSetupChange
}: {
  command: string
  source: string | null
  runPolicy: SetupRunPolicy
  decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  onDecisionChange: (decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'>) => void
  onRunSetupChange: (run: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const runSetupLabel = t(
    'components.newWorkspaceSetupScriptField.runSetupCommand',
    'Run setup command'
  )
  return (
    <View style={styles.setupStack}>
      <View style={styles.setupHeader}>
        <Text style={styles.setupLabel}>
          {t('components.newWorkspaceSetupScriptField.label', 'Setup script')}
        </Text>
        {source ? (
          <View style={styles.sourceBadge}>
            <Text style={styles.sourceBadgeText}>
              {source === 'orca.yaml'
                ? 'ORCA.YAML'
                : t('components.newWorkspaceSetupScriptField.hooks', 'HOOKS')}
            </Text>
          </View>
        ) : null}
      </View>
      {runPolicy === 'ask' ? (
        <ListGroup>
          <ListRow
            key="run"
            title={t('components.newWorkspaceSetupScriptField.run', 'Run')}
            selected={decision === 'run'}
            onPress={() => onDecisionChange('run')}
          />
          <ListRow
            key="skip"
            title={t('components.newWorkspaceSetupScriptField.skip', 'Skip')}
            selected={decision === 'skip'}
            onPress={() => onDecisionChange('skip')}
          />
        </ListGroup>
      ) : (
        <ListGroup>
          <ListRow
            key="runSetup"
            title={runSetupLabel}
            accessory={
              <MobileSwitch
                value={runSetup}
                onValueChange={onRunSetupChange}
                accessibilityLabel={runSetupLabel}
              />
            }
          />
        </ListGroup>
      )}
      <View style={styles.codeBlock}>
        <Text style={styles.code}>{command}</Text>
      </View>
    </View>
  )
}
