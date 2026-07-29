import { Platform, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  composer: MobileComposerSource
  selectedRepoIsGit: boolean
}

// The Advanced-section source controls: the editable Name appears once a source
// pill is shown (the field itself is no longer the name input); the branch-name
// override and reuse toggle mirror the desktop composer's advanced branch fields.
export function SmartWorkspaceAdvancedFields({ composer, selectedRepoIsGit }: Props) {
  const selection = composer.smartNameSelection
  const showBranchOverride = selectedRepoIsGit && (!selection || selection.kind === 'branch')
  return (
    <>
      {selection ? (
        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={composer.name}
            onChangeText={composer.setName}
            placeholder="Workspace name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {showBranchOverride ? (
        <View style={styles.field}>
          <Text style={styles.label}>Branch name</Text>
          <TextInput
            style={styles.input}
            value={composer.branchNameOverride ?? ''}
            onChangeText={composer.handleBranchNameOverrideChange}
            placeholder="Derived from name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {composer.reuseEligibleBranch ? (
        <View style={styles.field}>
          <View style={styles.reuseRow}>
            <Text style={styles.reuseLabel} numberOfLines={1}>
              Reuse branch “{composer.reuseEligibleBranch}”
            </Text>
            <Switch
              value={composer.reuseSelectedBranch}
              onValueChange={composer.setReuseSelectedBranch}
              trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
              style={styles.reuseSwitch}
            />
          </View>
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  reuseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  reuseLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.textSecondary
  },
  reuseSwitch: {
    transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }]
  }
})
