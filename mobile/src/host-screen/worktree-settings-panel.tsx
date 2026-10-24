import { useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { Worktree } from '../worktree/workspace-list-types'
import { hostScreenStyles } from './host-screen-styles'
import type { WorktreeRenameOutcome } from './use-host-worktree-rename'
import { automaticWorktreeDisplayName } from './worktree-display-name-edit'

type Props = {
  target: Worktree
  onCancel: () => void
  /** Resolves once the host answered. The caller closes the sheet on success. */
  onSave: (draft: string) => Promise<WorktreeRenameOutcome>
}

/**
 * The long-press sheet's Worktree Settings page: the desktop's Display Name field, drawn inline in
 * the same drawer (like Delete's confirm) so opening it costs no second modal.
 */
export function WorktreeSettingsPanel({ target, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState(target.displayName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const automaticName = automaticWorktreeDisplayName(target)

  async function save() {
    if (saving) {
      return
    }
    setSaving(true)
    setError(null)
    const outcome = await onSave(draft)
    // Why only on failure: a successful save unmounts this panel with the sheet.
    if (!outcome.ok) {
      setSaving(false)
      setError(outcome.error)
    }
  }

  return (
    <View>
      <View style={hostScreenStyles.confirmContent}>
        <Text style={hostScreenStyles.confirmTitle}>Worktree Settings</Text>
        <Text style={hostScreenStyles.confirmMessage} numberOfLines={1}>
          {automaticName}
        </Text>
      </View>

      <Text style={styles.label}>Display Name</Text>
      <TextInput
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder={automaticName}
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        selectionColor={colors.accentBlue}
        accessibilityLabel="Display Name"
      />
      <Text style={styles.help}>
        Shown in the sidebar. The folder name stays the same. Leave empty to use the branch name.
      </Text>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <View style={[hostScreenStyles.confirmButtons, styles.buttons]}>
        <Pressable
          style={({ pressed }) => [
            hostScreenStyles.confirmBtn,
            hostScreenStyles.confirmBtnCancel,
            pressed && hostScreenStyles.confirmBtnPressed
          ]}
          disabled={saving}
          onPress={onCancel}
        >
          <Text style={hostScreenStyles.confirmBtnCancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            hostScreenStyles.confirmBtn,
            styles.saveButton,
            (pressed || saving) && hostScreenStyles.confirmBtnPressed
          ]}
          disabled={saving}
          onPress={() => void save()}
        >
          <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  label: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  // Why: the same raised field as TextInputModal, so the sheet's input reads as tappable.
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: TEXT_INPUT_FONT_SIZE,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  help: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.xs,
    lineHeight: 17
  },
  error: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    marginTop: spacing.sm
  },
  buttons: {
    marginTop: spacing.lg
  },
  saveButton: {
    backgroundColor: colors.textPrimary
  },
  saveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.bgBase
  }
})
