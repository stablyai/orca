import { View, Text, Pressable } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { HostKindIcon } from './HostKindIcon'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { composerInputStyles, COMPOSER_TEXT_SIZE } from './composer-input/composer-input-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Selection = { label: string; detail?: string }

export function NewWorktreeProjectTargetFields({
  project,
  runTarget,
  projectBadgeColor,
  onOpenProject,
  onOpenRunTarget
}: {
  project: Selection | null
  runTarget: (Selection & { hostId: string }) | null
  projectBadgeColor: string | null
  onOpenProject: () => void
  onOpenRunTarget: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <>
      <View style={styles.field}>
        <Text style={styles.label}>
          {t('components.newWorktreeProjectTargetFields.project', 'Project')}
        </Text>
        <Pressable style={styles.fieldButton} onPress={onOpenProject}>
          {projectBadgeColor ? (
            <View style={[styles.projectDot, { backgroundColor: projectBadgeColor }]} />
          ) : null}
          <SelectionCopy
            selection={project}
            placeholder={t(
              'components.newWorktreeProjectTargetFields.selectProject',
              'Select a project'
            )}
          />
          <ChevronDown size={14} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>
          {t('components.newWorktreeProjectTargetFields.runOn', 'Run on')}
        </Text>
        <Pressable style={styles.fieldButton} onPress={onOpenRunTarget}>
          <HostKindIcon hostId={runTarget?.hostId} size={14} />
          <SelectionCopy
            selection={runTarget}
            placeholder={t(
              'components.newWorktreeProjectTargetFields.selectRunTarget',
              'Select a run target'
            )}
          />
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
  useMobileColorScheme()
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
  fieldButton: {
    ...composerInputStyles.field,
    paddingVertical: spacing.sm
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
    fontSize: COMPOSER_TEXT_SIZE,
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
}))
