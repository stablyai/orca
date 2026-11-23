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
  const runLabel = t('components.newWorkspaceSetupScriptField.runSetup', 'Run setup')
  const waitLabel = t(
    'components.newWorkspaceSetupScriptField.startAgentAfterSetup',
    'Start agent after setup'
  )
  const setupRuns = runPolicy === 'ask' ? decision === 'run' : runSetup
  return (
    <View>
      <View style={styles.setupHeader}>
        <Text style={styles.setupLabel}>
          {t('components.newWorkspaceSetupScriptField.label', 'Setup script')}
        </Text>
        {source === 'orca.yaml' ? <Text style={styles.setupSource}>orca.yaml</Text> : null}
      </View>
      <ListGroup>
        {runPolicy === 'ask' ? (
          [
            <ListRow
              key="run"
              title={runLabel}
              subtitle={command}
              subtitleMono
              subtitleLines={0}
              selected={decision === 'run'}
              onPress={() => onDecisionChange('run')}
              accessibilityLabel={`${runLabel}, ${command}`}
            />,
            <ListRow
              key="skip"
              title={t('components.newWorkspaceSetupScriptField.skip', 'Skip')}
              selected={decision === 'skip'}
              onPress={() => onDecisionChange('skip')}
            />
          ]
        ) : (
          <ListRow
            key="runSetup"
            title={runLabel}
            subtitle={command}
            subtitleMono
            subtitleLines={0}
            accessory={
              <MobileSwitch
                value={runSetup}
                onValueChange={onRunSetupChange}
                accessibilityLabel={runLabel}
              />
            }
          />
        )}
        {/* Waiting only means something when setup runs. */}
        {waitForSetup !== null && setupRuns ? (
          <ListRow
            key="waitForSetup"
            title={waitLabel}
            wrapTitle
            accessory={
              <MobileSwitch
                value={waitForSetup}
                onValueChange={onWaitForSetupChange}
                accessibilityLabel={waitLabel}
              />
            }
          />
        ) : null}
      </ListGroup>
    </View>
  )
}
