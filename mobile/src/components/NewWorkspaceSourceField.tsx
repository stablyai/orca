import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { ChevronDown, CircleDot, GitBranch, GitPullRequest, ListTodo, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { NewWorkspaceSourceController } from '../workspace-source/use-new-workspace-source'

type Props = {
  controller: NewWorkspaceSourceController
  onPrepareOpen: () => void
}

export function NewWorkspaceSourceField({ controller, onPrepareOpen }: Props) {
  if (!controller.fieldVisible) {
    return null
  }
  const source = controller.source
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        Start from <Text style={styles.labelHint}>[Optional]</Text>
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          source ? `Start from ${sourceLabel(source)}` : 'Choose a workspace source'
        }
        style={styles.fieldButton}
        onPress={() => {
          onPrepareOpen()
          controller.setDrawerVisible(true)
        }}
      >
        <SourceIcon source={source} />
        <Text style={[styles.fieldButtonText, !source && styles.placeholder]} numberOfLines={1}>
          {source ? sourceLabel(source) : 'Default branch'}
        </Text>
        {source ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear workspace source"
            hitSlop={10}
            style={styles.clearButton}
            onPress={(event) => {
              event.stopPropagation()
              controller.clearSource()
            }}
          >
            <X size={15} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <ChevronDown size={14} color={colors.textMuted} />
        )}
      </Pressable>
      {source?.kind === 'branch' && source.reuseEligibleBranch ? (
        <View style={styles.reuseRow}>
          <View style={styles.reuseCopy}>
            <Text style={styles.reuseTitle}>Reuse existing branch</Text>
            <Text style={styles.reuseSubtitle} numberOfLines={1}>
              Check out {source.reuseEligibleBranch} without creating a new branch.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Reuse existing branch"
            value={source.reuseEnabled}
            onValueChange={controller.setReuseEnabled}
            trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
            thumbColor={colors.textPrimary}
          />
        </View>
      ) : null}
      {source?.kind === 'github' && source.forkWarning ? (
        <Text style={styles.warning}>{source.forkWarning}</Text>
      ) : null}
    </View>
  )
}

function sourceLabel(source: NonNullable<NewWorkspaceSourceController['source']>): string {
  return source.kind === 'github'
    ? `${source.item.type === 'pr' ? 'PR' : 'Issue'} #${source.item.number}: ${source.item.title}`
    : source.kind === 'linear'
      ? `${source.issue.identifier}: ${source.issue.title}`
      : source.refName
}

function SourceIcon({ source }: { source: NewWorkspaceSourceController['source'] }) {
  const props = { size: 15, color: colors.textSecondary, strokeWidth: 2.1 }
  return !source || source.kind === 'branch' ? (
    <GitBranch {...props} />
  ) : source?.kind === 'linear' ? (
    <ListTodo {...props} />
  ) : source?.kind === 'github' && source.item.type === 'pr' ? (
    <GitPullRequest {...props} />
  ) : (
    <CircleDot {...props} />
  )
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  labelHint: { fontWeight: '400', color: colors.textMuted },
  fieldButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonText: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  placeholder: { color: colors.textMuted },
  clearButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing.md
  },
  reuseRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs
  },
  reuseCopy: { flex: 1, minWidth: 0 },
  reuseTitle: { fontSize: 13, color: colors.textPrimary },
  reuseSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  warning: { fontSize: 12, color: colors.statusAmber, marginTop: spacing.xs }
})
