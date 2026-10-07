import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { newWorktreeFormStyles as formStyles } from './new-worktree-form-styles'

export function addProjectFormHint(mode: 'clone' | 'create', remote: boolean) {
  if (remote) {
    return mode === 'clone'
      ? 'Choose a destination folder on the selected host. Large repositories can take a few minutes.'
      : 'Choose a parent folder on the selected host for the new project.'
  }
  return mode === 'clone'
    ? "Cloned into the host's default projects folder. Large repositories can take a few minutes."
    : "An empty git repository with an initial commit, created in the host's default projects folder."
}

export function AddProjectForm({
  mode,
  value,
  busy,
  error,
  invalidTargetMessage,
  hint,
  onChangeText,
  onBack,
  onSubmit
}: {
  mode: 'clone' | 'create'
  value: string
  busy: boolean
  error: string
  invalidTargetMessage: string
  hint: string
  onChangeText: (value: string) => void
  onBack: () => void
  onSubmit: () => void
}) {
  const copy = {
    clone: {
      title: 'Clone from URL',
      label: 'Repository URL',
      placeholder: 'https://github.com/owner/repo',
      button: 'Clone repository',
      keyboardType: 'url' as const
    },
    create: {
      title: 'Create new project',
      label: 'Project name',
      placeholder: 'my-project',
      button: 'Create project',
      keyboardType: 'default' as const
    }
  }[mode]
  const canSubmit = value.trim().length > 0 && !busy && !invalidTargetMessage

  return (
    <View>
      <View style={styles.headerRow}>
        <Pressable
          style={styles.backButton}
          onPress={onBack}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back to Add project"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </Pressable>
        <Text style={formStyles.title}>{copy.title}</Text>
      </View>
      <View style={formStyles.field}>
        <Text style={formStyles.label}>{copy.label}</Text>
        <TextInput
          style={formStyles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={copy.placeholder}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={copy.keyboardType}
          editable={!busy}
          accessibilityLabel={copy.label}
        />
        <Text style={styles.hint}>{hint}</Text>
      </View>
      {invalidTargetMessage ? <Text style={formStyles.error}>{invalidTargetMessage}</Text> : null}
      {error ? <Text style={formStyles.error}>{error}</Text> : null}
      <View style={formStyles.actions}>
        <Pressable
          style={[formStyles.createButton, !canSubmit && formStyles.createButtonDisabled]}
          disabled={!canSubmit}
          onPress={onSubmit}
          accessibilityRole="button"
          accessibilityLabel={copy.button}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={formStyles.createText}>{copy.button}</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md
  },
  backButton: {
    marginLeft: -spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  hint: { marginTop: spacing.xs, fontSize: typography.metaSize, color: colors.textMuted }
})
