import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import type { GitHubWorkItemDetails } from '../../../../src/shared/types'
import { colors } from '../../theme/mobile-theme'
import { PRSection } from './PRSection'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentCard } from './PRCommentCard'
import {
  PR_COMMENT_AUDIENCE_FILTERS,
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  type PRCommentAudienceFilter
} from './pr-comment-audience'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  type PRCommentGroup
} from './pr-comment-groups'
import { prCommentsStyles as styles } from './pr-comments-styles'
import { mobilePrSidebarStyles as shared } from './mobile-pr-sidebar-styles'

type Props = {
  details: GitHubWorkItemDetails | null
}

// PR body + full comment timeline, mirroring the desktop PR page: a Description
// card, then a Comments section with an audience filter (PRs only), threaded
// review comments, reactions, and collapsible resolved threads.
export function PRCommentsSection({ details }: Props) {
  const body = details?.body ?? ''
  const comments = useMemo(() => details?.comments ?? [], [details])
  const isPr = details?.item.type === 'pr'

  const [filter, setFilter] = useState<PRCommentAudienceFilter>('all')
  const counts = useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visible = useMemo(() => filterPRCommentsByAudience(comments, filter), [comments, filter])
  const groups = useMemo(() => groupPRComments(visible), [visible])

  return (
    <>
      <PRSection title="Description">
        {body.trim() ? (
          <CommentMarkdown content={body} variant="document" />
        ) : (
          <Text style={styles.noDescription}>No description provided.</Text>
        )}
      </PRSection>

      <PRSection
        title="Comments"
        trailing={
          comments.length > 0 ? (
            <View style={styles.countChip}>
              <Text style={styles.countChipText}>{comments.length}</Text>
            </View>
          ) : undefined
        }
      >
        {comments.length === 0 ? (
          <Text style={styles.empty}>No comments yet.</Text>
        ) : (
          <>
            {isPr ? (
              <View style={styles.audienceTabs}>
                {PR_COMMENT_AUDIENCE_FILTERS.map((tab) => {
                  const active = tab.value === filter
                  return (
                    <Pressable
                      key={tab.value}
                      style={[styles.audienceTab, active && styles.audienceTabActive]}
                      onPress={() => setFilter(tab.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text
                        style={[styles.audienceTabText, active && styles.audienceTabTextActive]}
                      >
                        {tab.label}
                      </Text>
                      <Text
                        style={[styles.audienceTabText, active && styles.audienceTabTextActive]}
                      >
                        {counts[tab.value]}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            {visible.length === 0 ? (
              <Text style={styles.empty}>{getPRCommentAudienceEmptyLabel(filter)}</Text>
            ) : (
              <View style={styles.list}>
                {groups.map((group) => (
                  <CommentGroupView key={getPRCommentGroupId(group)} group={group} />
                ))}
              </View>
            )}
          </>
        )}
      </PRSection>
    </>
  )
}

function CommentGroupView({ group }: { group: PRCommentGroup }) {
  const [expanded, setExpanded] = useState(false)
  const cards =
    group.kind === 'thread'
      ? [
          <PRCommentCard key={group.root.id} comment={group.root} />,
          ...group.replies.map((reply) => <PRCommentCard key={reply.id} comment={reply} isReply />)
        ]
      : [<PRCommentCard key={group.comment.id} comment={group.comment} />]

  if (!isResolvedPRCommentGroup(group)) {
    return <View style={styles.group}>{cards}</View>
  }

  // Resolved threads collapse behind a summary row (desktop accordion parity).
  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <View style={styles.group}>
      <Pressable
        style={styles.resolvedHeader}
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
      >
        <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.resolvedHeaderText} numberOfLines={1}>
          Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {root.author}
          {count > 1 ? ` (${count})` : ''}
        </Text>
      </Pressable>
      {expanded ? <View style={shared.sectionBody}>{cards}</View> : null}
    </View>
  )
}
