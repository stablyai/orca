import type { ReactNode } from 'react'
import { GitBranch, Sparkles } from 'lucide-react-native'
import type { SmartWorkspaceSourceRow as SourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import { colors } from '../theme/mobile-theme'
import { TaskProviderLogo } from './TaskProviderLogo'
import { Badge, type BadgeTone } from './ui/Badge'
import { ListRow } from './ui/ListRow'

type Props = {
  row: SourceRow
  onPress: () => void
}

type RowContent = {
  icon: ReactNode
  title: string
  subtitle?: string
  status?: string
}

const ICON_SIZE = 18
const ICON_COLOR = colors.textSecondary

function resolveRowContent(row: SourceRow): RowContent {
  switch (row.kind) {
    case 'use-name':
      return {
        icon: <Sparkles size={ICON_SIZE} color={ICON_COLOR} />,
        title: `Use “${row.name}”`,
        subtitle: 'Name this workspace'
      }
    case 'create-branch':
      return {
        icon: <GitBranch size={ICON_SIZE} color={ICON_COLOR} />,
        title: `Create branch “${row.name}”`,
        subtitle: 'New branch'
      }
    case 'github':
      return {
        icon: <TaskProviderLogo provider="github" size={ICON_SIZE} color={ICON_COLOR} />,
        title: row.item.title,
        subtitle: `${row.item.type === 'pr' ? 'PR #' : 'Issue #'}${row.item.number}`,
        status: row.item.state
      }
    case 'gitlab':
      return {
        icon: <TaskProviderLogo provider="gitlab" size={ICON_SIZE} color={ICON_COLOR} />,
        title: row.item.title,
        subtitle: `${row.item.type === 'mr' ? 'MR !' : 'Issue #'}${row.item.number}`,
        status: row.item.state
      }
    case 'branch':
      return {
        icon: <GitBranch size={ICON_SIZE} color={ICON_COLOR} />,
        title: row.localBranchName || row.refName,
        subtitle: row.refName
      }
    case 'linear':
      return {
        icon: <TaskProviderLogo provider="linear" size={ICON_SIZE} color={ICON_COLOR} />,
        title: row.issue.title,
        subtitle: `${row.issue.identifier} · ${row.issue.team?.key ?? 'Linear'}`,
        status: row.issue.state?.name
      }
    case 'jira':
      return {
        icon: <TaskProviderLogo provider="jira" size={ICON_SIZE} color={ICON_COLOR} />,
        title: row.issue.title,
        subtitle: `${row.issue.key} · ${row.issue.project?.key ?? 'Jira'}`,
        status: row.issue.status?.name
      }
  }
}

/** Providers send states in their own case ("open", "In Progress"); the badge reads as a label. */
function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/** Open and merged PRs, MRs and issues get their colour; tracker states vary per team, so stay neutral. */
function statusTone(row: SourceRow, status: string): BadgeTone {
  if (row.kind !== 'github' && row.kind !== 'gitlab') {
    return 'neutral'
  }
  const state = status.toLowerCase()
  if (state === 'open' || state === 'opened') {
    return 'green'
  }
  return state === 'merged' ? 'purple' : 'neutral'
}

export function SmartWorkspaceSourceRow({ row, onPress }: Props) {
  const content = resolveRowContent(row)
  return (
    <ListRow
      title={content.title}
      subtitle={content.subtitle}
      leading={content.icon}
      accessory={
        content.status ? (
          <Badge label={statusLabel(content.status)} tone={statusTone(row, content.status)} />
        ) : undefined
      }
      onPress={onPress}
    />
  )
}
