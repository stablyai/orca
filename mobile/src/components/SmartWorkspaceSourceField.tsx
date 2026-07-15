import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  X
} from 'lucide-react-native'
import type { SmartNameSelection } from '../tasks/mobile-composer-source-types'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'

type Props = {
  composer: MobileComposerSource
  label: string
  disabled?: boolean
  onBeforeOpen?: () => void
  onOpenDrawer: () => void
}

function SelectionIcon({ kind }: { kind: SmartNameSelection['kind'] }) {
  if (kind === 'github-pr') {
    return <GitPullRequest size={15} color={colors.textSecondary} />
  }
  if (kind === 'gitlab-mr') {
    return <GitMerge size={15} color={colors.textSecondary} />
  }
  if (kind === 'github-issue' || kind === 'gitlab-issue') {
    return <CircleDot size={15} color={colors.textSecondary} />
  }
  if (kind === 'branch') {
    return <GitBranch size={15} color={colors.textSecondary} />
  }
  return <TaskProviderLogo provider="linear" size={15} color={colors.textSecondary} />
}

export function SmartWorkspaceSourceField({
  composer,
  label,
  disabled,
  onBeforeOpen,
  onOpenDrawer
}: Props) {
  const selection = composer.smartNameSelection

  function openDrawer(): void {
    if (disabled) {
      return
    }
    onBeforeOpen?.()
    onOpenDrawer()
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label} <Text style={styles.labelHint}>[Optional]</Text>
      </Text>
      {selection ? (
        <View style={styles.pill}>
          <SelectionIcon kind={selection.kind} />
          <Text style={styles.pillLabel} numberOfLines={1}>
            {selection.label}
          </Text>
          {selection.url ? (
            <Pressable
              hitSlop={6}
              onPress={() => selection.url && void Linking.openURL(selection.url).catch(() => {})}
            >
              <ExternalLink size={15} color={colors.textMuted} />
            </Pressable>
          ) : null}
          <Pressable hitSlop={6} onPress={composer.handleClearSmartNameSelection}>
            <X size={15} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          style={[styles.input, disabled && styles.disabled]}
          disabled={disabled}
          onPress={openDrawer}
        >
          <Text
            style={[styles.inputText, !composer.name && styles.inputPlaceholder]}
            numberOfLines={1}
          >
            {composer.name || 'Type a name or search a source'}
          </Text>
        </Pressable>
      )}
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
  labelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  disabled: {
    opacity: 0.55
  },
  inputText: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  inputPlaceholder: {
    color: colors.textMuted
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  pillLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  }
})
