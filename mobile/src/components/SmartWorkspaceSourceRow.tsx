import { Text, View } from 'react-native'
import { GitBranch, Sparkles } from 'lucide-react-native'
import type { SmartWorkspaceSourceRow as SourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { TaskProviderLogo } from './TaskProviderLogo'
import { ListRow } from './list/ListRow'

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

function resolveRowContent(row: SourceRow, t: Translate): RowContent {
  switch (row.kind) {
    case 'use-name':
      return {
        icon: <Sparkles size={18} color={colors.textSecondary} />,
        title: t('components.smartWorkspaceSourceRow.useName', 'Use "{{name}}"', {
          name: row.name
        }),
        subtitle: t('components.smartWorkspaceSourceRow.nameWorkspace', 'Name this workspace')
      }
    case 'create-branch':
      return {
        icon: <GitBranch size={18} color={colors.accentBlue} />,
        title: t('components.smartWorkspaceSourceRow.createBranch', 'Create branch "{{name}}"', {
          name: row.name
        }),
        subtitle: t('components.smartWorkspaceSourceRow.newBranch', 'New branch')
      }
    case 'github':
      return {
        icon: <TaskProviderLogo provider="github" size={18} color={colors.textSecondary} />,
        title: row.item.title,
        subtitle:
          row.item.type === 'pr'
            ? t('components.smartWorkspaceSourceRow.pullRequest', 'PR #{{number}}', {
                number: row.item.number
              })
            : t('components.smartWorkspaceSourceRow.issue', 'Issue #{{number}}', {
                number: row.item.number
              }),
        status: row.item.state
      }
    case 'gitlab':
      return {
        icon: <TaskProviderLogo provider="gitlab" size={18} color={colors.textSecondary} />,
        title: row.item.title,
        subtitle:
          row.item.type === 'mr'
            ? t('components.smartWorkspaceSourceRow.mergeRequest', 'MR !{{number}}', {
                number: row.item.number
              })
            : t('components.smartWorkspaceSourceRow.issue', 'Issue #{{number}}', {
                number: row.item.number
              }),
        status: row.item.state
      }
    case 'branch':
      return {
        icon: <GitBranch size={18} color={colors.textSecondary} />,
        title: row.localBranchName || row.refName,
        subtitle: row.refName
      }
    case 'linear':
      return {
        icon: <TaskProviderLogo provider="linear" size={18} color={colors.textSecondary} />,
        title: row.issue.title,
        subtitle: `${row.issue.identifier} · ${row.issue.team?.key ?? 'Linear'}`,
        status: row.issue.state?.name
      }
    case 'jira':
      return {
        icon: <TaskProviderLogo provider="jira" size={18} color={colors.textSecondary} />,
        title: row.issue.title,
        subtitle: `${row.issue.key} · ${row.issue.project?.key ?? 'Jira'}`,
        status: row.issue.status?.name
      }
  }
}

export function SmartWorkspaceSourceRow({ row, onPress }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const content = resolveRowContent(row, t)
  return (
    <ListRow
      title={content.title}
      subtitle={content.subtitle}
      leading={content.icon}
      accessory={
        content.status ? (
          <View style={styles.pill}>
            <Text style={styles.pillText} numberOfLines={1}>
              {content.status}
            </Text>
          </View>
        ) : undefined
      }
      onPress={onPress}
    />
  )
}

const styles = themedStyleSheet(() => ({
  pill: {
    backgroundColor: colors.sheetSurface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    maxWidth: 120
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'capitalize'
  }
}))
