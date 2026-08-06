import { Pressable, StyleSheet, Text, View } from 'react-native'
import { CaseSensitive, GitBranch, Sparkles } from 'lucide-react-native'
import type { SmartWorkspaceSourceRow as SourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  row: SourceRow
  onPress: () => void
}

type RowContent = {
  icon: React.ReactNode
  title: string
  subtitle?: string
  status?: string
}

function resolveRowContent(row: SourceRow): RowContent {
  switch (row.kind) {
    case 'use-name':
      return {
        icon: <Sparkles size={16} color={colors.textSecondary} />,
        title: t('smartWorkspaceSourceRow.use', { rowName: row.name }),
        subtitle: t('smartWorkspaceSourceRow.name')
      }
    case 'create-branch':
      return {
        icon: <GitBranch size={16} color={colors.accentBlue} />,
        title: t('smartWorkspaceSourceRow.create', {
          rowName: row.name
        }),
        subtitle: t('smartWorkspaceSourceRow.new')
      }
    case 'github':
      return {
        icon: <TaskProviderLogo provider="github" size={16} color={colors.textSecondary} />,
        title: row.item.title,
        subtitle: `${row.item.type === 'pr' ? t('smartWorkspaceSourceRow.pr') : t('smartWorkspaceSourceRow.issue')}${row.item.number}`,
        status: row.item.state
      }
    case 'gitlab':
      return {
        icon: <TaskProviderLogo provider="gitlab" size={16} color={colors.textSecondary} />,
        title: row.item.title,
        subtitle: `${row.item.type === 'mr' ? t('smartWorkspaceSourceRow.mr') : t('smartWorkspaceSourceRow.issue')}${row.item.number}`,
        status: row.item.state
      }
    case 'branch':
      return {
        icon: <GitBranch size={16} color={colors.textSecondary} />,
        title: row.localBranchName || row.refName,
        subtitle: row.refName
      }
    case 'linear':
      return {
        icon: <TaskProviderLogo provider="linear" size={16} color={colors.textSecondary} />,
        title: row.issue.title,
        subtitle: `${row.issue.identifier} · ${row.issue.team?.key ?? t('smartWorkspaceSourceRow.linear')}`,
        status: row.issue.state?.name
      }
    default:
      return { icon: <CaseSensitive size={16} color={colors.textSecondary} />, title: '' }
  }
}

export function SmartWorkspaceSourceRow({ row, onPress }: Props) {
  const content = resolveRowContent(row)
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      <View style={styles.icon}>{content.icon}</View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {content.title}
        </Text>
        {content.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {content.subtitle}
          </Text>
        ) : null}
      </View>
      {content.status ? (
        <View style={styles.pill}>
          <Text style={styles.pillText} numberOfLines={1}>
            {content.status}
          </Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  icon: {
    width: 18,
    alignItems: 'center'
  },
  copy: {
    flex: 1,
    minWidth: 0
  },
  title: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 1
  },
  pill: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'capitalize'
  }
})
