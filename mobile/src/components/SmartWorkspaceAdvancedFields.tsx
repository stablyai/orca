import { Text, View } from 'react-native'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSwitch } from './MobileSwitch'
import { TextField } from './composer-input/TextField'
import { LIST_ROW_PADDING, ListGroup } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { newWorktreeFormStyles } from './new-worktree-form-styles'

type Props = {
  composer: MobileComposerSource
  selectedRepoIsGit: boolean
}

// Show editable Name after source pill; branch override/reuse follow desktop’s advanced composer fields.
export function SmartWorkspaceAdvancedFields({ composer, selectedRepoIsGit }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const selection = composer.smartNameSelection
  const showBranchOverride = selectedRepoIsGit && (!selection || selection.kind === 'branch')
  const reuseTitle = t('workspace.branchChoice.existing', 'Existing branch')
  return (
    <>
      {selection ? (
        <View>
          <Text style={newWorktreeFormStyles.fieldLabel}>
            {t('components.smartWorkspaceAdvancedFields.name', 'Name')}
          </Text>
          <TextField
            value={composer.name}
            onChangeText={composer.setName}
            placeholder={t(
              'components.smartWorkspaceAdvancedFields.workspaceName',
              'Workspace name'
            )}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {showBranchOverride && !composer.reuseEligibleBranch ? (
        <View>
          <Text style={newWorktreeFormStyles.fieldLabel}>
            {t('components.smartWorkspaceAdvancedFields.branchName', 'Branch name')}
          </Text>
          <TextField
            value={composer.branchNameOverride ?? ''}
            onChangeText={composer.handleBranchNameOverrideChange}
            placeholder={t(
              'components.smartWorkspaceAdvancedFields.derivedFromName',
              'Derived from name'
            )}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {composer.reuseEligibleBranch ? (
        <View>
          <Text style={newWorktreeFormStyles.fieldLabel}>
            {t('workspace.branchChoice.title', 'Branch for this worktree')}
          </Text>
          <ListGroup>
            <ListRow
              key="reuse"
              title={reuseTitle}
              subtitle={composer.reuseEligibleBranch}
              accessory={
                <MobileSwitch
                  value={composer.reuseSelectedBranch}
                  onValueChange={composer.setReuseSelectedBranch}
                  accessibilityLabel={reuseTitle}
                />
              }
            />
          </ListGroup>
          {composer.reuseSelectedBranch ? (
            <Text style={styles.hint}>
              {t('workspace.branchChoice.existingHint', 'New commits go on this branch.')}
            </Text>
          ) : (
            <View style={styles.newBranch}>
              <Text style={styles.hint}>
                {t('workspace.branchChoice.newHint', 'Create a new local branch')}
              </Text>
              <Text style={[newWorktreeFormStyles.fieldLabel, styles.newBranchLabel]}>
                {t('workspace.branchChoice.newName', 'New branch name')}
              </Text>
              <TextField
                accessibilityLabel={t('workspace.branchChoice.newName', 'New branch name')}
                // Turning reuse off mounts this field, so it takes focus straight away.
                autoFocus
                value={composer.branchNameOverride ?? ''}
                onChangeText={composer.handleBranchNameOverrideChange}
                placeholder={t('workspace.branchChoice.automaticName', 'Automatic name')}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}
        </View>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  hint: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: LIST_ROW_PADDING,
    marginTop: 6
  },
  newBranch: {
    gap: 6
  },
  newBranchLabel: {
    marginTop: spacing.sm,
    marginBottom: 0
  }
}))
