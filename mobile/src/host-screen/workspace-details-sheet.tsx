import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  CalendarClock,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  SquareTerminal,
  StickyNote
} from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { prStateColor } from '../components/WorktreeMetaGlyphs'
import { hostScreenStyles } from './host-screen-styles'
import { OptionRowList } from './workspace-option-rows'
import { TaskProviderLogo } from '../components/TaskProviderLogo'
import { getWorktreeGitIdentityDisplay } from '../../../src/shared/worktree/git-identity-display'
import {
  buildWorkspaceDetailLinks,
  buildWorkspaceOrigin,
  workspaceNotes,
  type WorkspaceDetailLink,
  type WorkspaceOrigin
} from '../worktree/workspace-details-model'
import type { Worktree } from '../worktree/workspace-list-types'

const ICON_SIZE = 16

const PROVIDER_LABELS: Record<WorkspaceDetailLink['provider'], string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  'azure-devops': 'Azure DevOps',
  gitea: 'Gitea'
}
const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  draft: 'Draft'
}
const CHECK_LABELS: Record<string, string> = {
  success: 'Checks: Passing',
  failure: 'Checks: Failing',
  pending: 'Checks: Pending'
}

export function WorkspaceDetailsSheet(props: { row: Worktree; onOpenLink: (url: string) => void }) {
  const { row, onOpenLink } = props
  const identity = getWorktreeGitIdentityDisplay({ branch: row.branch })
  const origin = buildWorkspaceOrigin(row)
  const OriginIcon = origin?.kind === 'automation' ? CalendarClock : SquareTerminal
  const notes = workspaceNotes(row)
  const rows: ReactNode[] = buildWorkspaceDetailLinks(row).map((item) => (
    <LinkRow key={item.key} item={item} onOpen={onOpenLink} />
  ))
  if (notes) {
    rows.push(
      <DetailRow key="notes" icon={<StickyNote size={ICON_SIZE} color={colors.textSecondary} />}>
        <Text style={styles.notes} selectable>
          {notes}
        </Text>
      </DetailRow>
    )
  }
  return (
    <>
      <View style={styles.header}>
        <Text style={styles.heading} numberOfLines={1}>
          {row.displayName || row.repo}
        </Text>
        {identity?.kind === 'branch' ? (
          <Text style={styles.branch} numberOfLines={1}>
            {identity.branchName}
          </Text>
        ) : null}
        {origin ? (
          <View style={styles.origin} testID="workspace-origin">
            <OriginIcon size={12} color={colors.textMuted} style={styles.originIcon} />
            <Text style={styles.originText} numberOfLines={2}>
              {originLabel(origin)}
            </Text>
          </View>
        ) : null}
      </View>
      {rows.length > 0 && (
        <View testID="workspace-details" style={hostScreenStyles.filterGroup}>
          <OptionRowList>{rows}</OptionRowList>
        </View>
      )}
    </>
  )
}

function originLabel(origin: WorkspaceOrigin): string {
  if (origin.kind === 'cli') {
    return 'Created from Orca CLI'
  }
  return origin.name ? `Created by automation \u201c${origin.name}\u201d` : 'Created by automation'
}

function DetailRow(props: {
  icon: ReactNode
  children: ReactNode
  trailing?: ReactNode
  onPress?: () => void
  accessibilityLabel?: string
}) {
  const body = (
    <>
      <View style={styles.icon}>{props.icon}</View>
      <View style={styles.text}>{props.children}</View>
      {props.trailing}
    </>
  )
  if (!props.onPress) {
    return <View style={styles.row}>{body}</View>
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={props.onPress}
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel}
    >
      {body}
    </Pressable>
  )
}

function ReviewIcon({ item }: { item: WorkspaceDetailLink }) {
  const color = prStateColor(item.state ?? '')
  if (
    item.state === 'merged' ||
    (item.type === 'mr' && item.state !== 'closed' && item.state !== 'draft')
  ) {
    return <GitMerge size={ICON_SIZE} color={color} />
  }
  if (item.state === 'closed') {
    return <GitPullRequestClosed size={ICON_SIZE} color={color} />
  }
  if (item.state === 'draft') {
    return <GitPullRequestDraft size={ICON_SIZE} color={color} />
  }
  return <GitPullRequest size={ICON_SIZE} color={color} />
}

function LinkIcon({ item }: { item: WorkspaceDetailLink }) {
  if (item.type !== 'issue') {
    return <ReviewIcon item={item} />
  }
  if (item.provider === 'linear' || item.provider === 'jira') {
    return (
      <TaskProviderLogo provider={item.provider} size={ICON_SIZE} color={colors.textSecondary} />
    )
  }
  return <CircleDot size={ICON_SIZE} color={colors.textSecondary} />
}

function linkMeta(item: WorkspaceDetailLink): string {
  const reference = item.title ? item.label : null
  if (item.type === 'issue') {
    return [reference, PROVIDER_LABELS[item.provider]].filter(Boolean).join(' · ')
  }
  // As the desktop's tone rule: checks only speak for a review that is still open.
  const checks = item.state === 'open' && item.checks ? CHECK_LABELS[item.checks] : null
  return [reference, item.state ? STATE_LABELS[item.state] : null, checks]
    .filter(Boolean)
    .join(' · ')
}

function LinkRow({ item, onOpen }: { item: WorkspaceDetailLink; onOpen: (url: string) => void }) {
  const url = item.url
  const meta = linkMeta(item)
  return (
    <DetailRow
      icon={<LinkIcon item={item} />}
      onPress={url ? () => onOpen(url) : undefined}
      accessibilityLabel={`Open ${item.label}${item.title ? `, ${item.title}` : ''}`}
      trailing={url ? <ExternalLink size={14} color={colors.textMuted} /> : undefined}
    >
      <Text style={styles.title} numberOfLines={1}>
        {item.title ?? item.label}
      </Text>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </DetailRow>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.md - 2
  },
  heading: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary
  },
  branch: {
    marginTop: 1,
    fontSize: 11.5,
    fontFamily: typography.monoFamily,
    color: colors.textMuted
  },
  origin: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
    marginTop: 3
  },
  originIcon: {
    marginTop: 2
  },
  originText: {
    flex: 1,
    fontSize: typography.metaSize,
    lineHeight: 16,
    color: colors.textMuted
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    minHeight: 46,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  icon: {
    width: ICON_SIZE,
    alignItems: 'center'
  },
  text: {
    flex: 1,
    minWidth: 0
  },
  title: {
    fontSize: typography.bodySize,
    lineHeight: 19,
    fontWeight: '500',
    color: colors.textPrimary
  },
  meta: {
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  notes: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary
  }
})
