import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
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

// Render comments in bounded pages — the whole sidebar is one ScrollView (can't
// virtualize a nested list), so eagerly rendering a large set parses markdown for
// every comment synchronously and ANRs the JS thread. Start small, reveal in chunks.
const COMMENT_PAGE = 12

// PR body + full comment timeline, mirroring the desktop PR page: a Description
// card, then a Comments section with an audience filter (PRs only), threaded
// review comments, reactions, and collapsible resolved threads.
export function PRCommentsSection({ details }: Props) {
  // details is null while phase 2 (the heavy comments/body payload) is still loading.
  const loadingDetails = details === null
  const body = details?.body ?? ''
  const comments = useMemo(() => details?.comments ?? [], [details])
  const isPr = details?.item.type === 'pr'

  const [filter, setFilter] = useState<PRCommentAudienceFilter>('all')
  const counts = useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const visible = useMemo(() => filterPRCommentsByAudience(comments, filter), [comments, filter])
  const groups = useMemo(() => groupPRComments(visible), [visible])

  // Bounded render window; reset to the first page whenever the filtered set changes.
  const [limit, setLimit] = useState(COMMENT_PAGE)
  useEffect(() => {
    setLimit(COMMENT_PAGE)
  }, [filter])
  const shownGroups = groups.slice(0, limit)
  const remaining = groups.length - shownGroups.length

  return (
    <>
      <PRSection title="Description">
        {loadingDetails ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : body.trim() ? (
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
        {loadingDetails ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : comments.length === 0 ? (
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
                {shownGroups.map((group) => (
                  <CommentGroupView key={getPRCommentGroupId(group)} group={group} />
                ))}
                {remaining > 0 ? (
                  <Pressable
                    style={styles.showMore}
                    onPress={() => setLimit((l) => l + COMMENT_PAGE)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.showMoreText}>
                      Show {Math.min(remaining, COMMENT_PAGE)} more
                      {remaining > COMMENT_PAGE ? ` of ${remaining}` : ''}
                    </Text>
                  </Pressable>
                ) : null}
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
