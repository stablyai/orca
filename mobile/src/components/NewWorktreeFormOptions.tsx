import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { AutoHeight } from './AutoHeight'
import { TextField } from './composer-input/TextField'
import { SectionHeader } from './list/SectionHeader'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'
import { NewWorkspaceSetupScriptField } from './NewWorkspaceSetupScriptField'
import { SmartWorkspaceAdvancedFields } from './SmartWorkspaceAdvancedFields'

type SetupDecision = Exclude<WorkspaceCreateSetupDecision, 'inherit'>

/** The form's collapsed "Options": name and branch overrides, a note, and the setup script. */
export function NewWorktreeFormOptions(props: {
  expanded: boolean
  composer: ReturnType<typeof useMobileComposerSource>
  selectedRepoIsGit: boolean
  note: string
  setupCommand: string | null
  setupSource: string | null
  setupRunPolicy: SetupRunPolicy
  setupDecisionChoice: SetupDecision | null
  runSetup: boolean
  onExpandedChange: (expanded: boolean) => void
  onNoteChange: (note: string) => void
  onSetupDecisionChange: (decision: SetupDecision) => void
  onRunSetupChange: (run: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <>
      <SectionHeader
        title={t('components.newWorktreeFormSheet.options', 'Options')}
        expanded={props.expanded}
        onToggle={() => props.onExpandedChange(!props.expanded)}
      />
      <AutoHeight>
        {props.expanded ? (
          <View style={styles.options}>
            <SmartWorkspaceAdvancedFields
              composer={props.composer}
              selectedRepoIsGit={props.selectedRepoIsGit}
            />
            <View>
              <Text style={styles.fieldLabel}>
                {t('components.newWorktreeFormSheet.note', 'Note')}
              </Text>
              <TextField
                value={props.note}
                onChangeText={props.onNoteChange}
                placeholder={t('components.newWorktreeFormSheet.notePlaceholder', 'Write a note')}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            {props.setupCommand ? (
              <NewWorkspaceSetupScriptField
                command={props.setupCommand}
                source={props.setupSource}
                runPolicy={props.setupRunPolicy}
                decision={props.setupDecisionChoice}
                runSetup={props.runSetup}
                onDecisionChange={props.onSetupDecisionChange}
                onRunSetupChange={props.onRunSetupChange}
              />
            ) : null}
          </View>
        ) : null}
      </AutoHeight>
    </>
  )
}
