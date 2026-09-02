import { View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { ChevronDown, Monitor } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Selection = { label: string; detail?: string }

export function NewWorktreeProjectTargetFields({
  project,
  runTarget,
  projectBadgeColor,
  onOpenProject,
  onOpenRunTarget
}: {
  project: Selection | null
  runTarget: Selection | null
  projectBadgeColor: string | null
  onOpenProject: () => void
  onOpenRunTarget: () => void
}) {
  return (
    <>
      <View style={styles.field}>
        <Text style={styles.label}>Project</Text>
        <Pressable style={styles.fieldButton} onPress={onOpenProject}>
          {projectBadgeColor ? (
            <View style={[styles.projectDot, { backgroundColor: projectBadgeColor }]} />
          ) : null}
          <SelectionCopy selection={project} placeholder="Select a project" />
          <ChevronDown size={14} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Run on</Text>
        <Pressable style={styles.fieldButton} onPress={onOpenRunTarget}>
          <Monitor size={14} color={colors.textMuted} />
          <SelectionCopy selection={runTarget} placeholder="Select a run target" />
          <ChevronDown size={14} color={colors.textMuted} />
        </Pressable>
      </View>
    </>
  )
}

function SelectionCopy({
  selection,
  placeholder
}: {
  selection: Selection | null
  placeholder: string
}) {
  return (
    <View style={styles.fieldButtonCopy}>
      <Text
        style={[styles.fieldButtonText, !selection && styles.fieldButtonPlaceholder]}
        numberOfLines={1}
      >
        {selection?.label ?? placeholder}
      </Text>
      {selection?.detail ? (
        <Text style={styles.fieldButtonDetail} numberOfLines={1}>
          {selection.detail}
        </Text>
      ) : null}
    </View>
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
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm
  },
  projectDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  fieldButtonCopy: {
    flex: 1,
    minWidth: 0
  },
  fieldButtonText: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  fieldButtonDetail: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: 1
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  }
})
