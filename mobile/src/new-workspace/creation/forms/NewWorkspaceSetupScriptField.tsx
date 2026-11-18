import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../../src/shared/worktree/create-types'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileSwitch } from '../../../components/controls/MobileSwitch'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'

export function NewWorkspaceSetupScriptField({
  command,
  source,
  runPolicy,
  decision,
  runSetup,
  onDecisionChange,
  onRunSetupChange,
  waitForSetup,
  onWaitForSetupChange
}: {
  command: string
  source: string | null
  runPolicy: SetupRunPolicy
  decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  onDecisionChange: (decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'>) => void
  onRunSetupChange: (run: boolean) => void
  /** Null hides the switch: the host reports no setup script an agent could wait for. */
  waitForSetup: boolean | null
  onWaitForSetupChange: (wait: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const runSetupLabel = t(
    'components.newWorkspaceSetupScriptField.runSetupCommand',
    'Run setup command'
  )
  const waitLabel = t(
    'components.newWorkspaceSetupScriptField.waitForSetup',
    'Wait for setup to complete before starting agent'
  )
  // As desktop: the choice only matters when setup runs, so it stays visible but inert otherwise.
  const setupRuns = runPolicy === 'ask' ? decision === 'run' : runSetup
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
      {waitForSetup !== null ? (
        <ListGroup>
          <ListRow
            key="waitForSetup"
            title={waitLabel}
            disabled={!setupRuns}
            accessory={
              <MobileSwitch
                value={waitForSetup}
                onValueChange={onWaitForSetupChange}
                disabled={!setupRuns}
                accessibilityLabel={waitLabel}
              />
            }
          />
        </ListGroup>
      ) : null}
      <View style={styles.codeBlock}>
        <Text style={styles.code}>{command}</Text>
      </View>
    </View>
  )
}
