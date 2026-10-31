import { useRef } from 'react'
import { Text, View, type TextInput } from 'react-native'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSegmentedControl } from './MobileSegmentedControl'
import { TextField } from './composer-input/TextField'

type Props = {
  composer: MobileComposerSource
  selectedRepoIsGit: boolean
}

// Show editable Name after source pill; branch override/reuse follow desktop’s advanced composer fields.
export function SmartWorkspaceAdvancedFields({ composer, selectedRepoIsGit }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const branchNameInputRef = useRef<TextInput>(null)
  const selection = composer.smartNameSelection
  const showBranchOverride = selectedRepoIsGit && (!selection || selection.kind === 'branch')
  return (
    <>
      {selection ? (
        <View style={styles.field}>
          <Text style={styles.label}>
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
        <View style={styles.field}>
          <Text style={styles.label}>
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
        <View style={styles.field}>
          <Text style={styles.label}>
            {t('workspace.branchChoice.title', 'Branch for this worktree')}
          </Text>
          <MobileSegmentedControl
            segments={[
              { value: 'existing', label: t('workspace.branchChoice.existing', 'Existing branch') },
              { value: 'new', label: t('workspace.branchChoice.new', 'New branch') }
            ]}
            selected={composer.reuseSelectedBranch ? 'existing' : 'new'}
            onSelect={(value) => {
              composer.setReuseSelectedBranch(value === 'existing')
              if (value === 'new') {
                branchNameInputRef.current?.focus()
              }
            }}
            fill
          />
          {composer.reuseSelectedBranch ? (
            <View style={styles.branchDetail}>
              <Text style={styles.branchName}>{composer.reuseEligibleBranch}</Text>
              <Text style={styles.description}>
                {t('workspace.branchChoice.existingHint', 'New commits go on this branch.')}
              </Text>
            </View>
          ) : (
            <View style={styles.branchDetail}>
              <Text style={styles.description}>
                {t('workspace.branchChoice.newHint', 'Create a new local branch')}
              </Text>
              <Text style={styles.label}>
                {t('workspace.branchChoice.newName', 'New branch name')}
              </Text>
              <TextField
                inputRef={branchNameInputRef}
                accessibilityLabel={t('workspace.branchChoice.newName', 'New branch name')}
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
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  branchDetail: {
    marginTop: spacing.sm,
    gap: spacing.xs
  },
  branchName: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    color: colors.textPrimary
  },
  description: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  }
}))
