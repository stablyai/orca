import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import type { GitHubWorkItemDetails, PRState } from '../../../../src/shared/types'
import type { GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import { colors } from '../../theme/mobile-theme'
import { canAddRootComment } from '../../session/pr-comment-actions'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import type { MobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import { PRSection } from './PRSection'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentCard, type PRCommentCardActions } from './PRCommentCard'
import { PRCommentComposer } from './PRCommentComposer'
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
import { t } from '@/i18n/mobile-i18n'

type Props = {
  details: GitHubWorkItemDetails | null
  // The PR conversation state — gates the root-comment composer (open PRs only).
  prState: PRState | null
  // Repo slug for the slug-addressed comment edit/delete RPCs; threaded into the
  // per-card actions so the edit/delete affordances can gate on its presence.
  prRepo?: GitHubPrRepoSlug | null
  // Interactive comment actions (reply/resolve/add/edit/delete). Absent (e.g.
  // non-PR) leaves the timeline read-only.
  actions?: MobilePrCommentActions
  // Author logins manually marked as bots on desktop; keeps the Humans/Bots
  // tabs classifying the same comments as the desktop panel.
  botAuthorOverrides?: ReadonlySet<string>
}

// Render comments in bounded pages — the whole sidebar is one ScrollView (can't
// virtualize a nested list), so eagerly rendering a large set parses markdown for
// every comment synchronously and ANRs the JS thread. Start small, reveal in chunks.
const COMMENT_PAGE = 12

// PR body + full comment timeline, mirroring the desktop PR page: a Description
// card, then a Comments section with an audience filter (PRs only), threaded
// review comments, reactions, and collapsible resolved threads.
export function PRCommentsSection({
  details,
  prState,
  prRepo,
  actions,
  botAuthorOverrides
}: Props) {
  // details is null while phase 2 (the heavy comments/body payload) is still loading.
  // A synthetic placeholder means phase 2 failed — do not paint that as empty success.
  const loadingDetails = details === null
  const detailsFailed = details != null && isPrSidebarDetailsPlaceholder(details)
  const body = details?.body ?? ''
  const comments = useMemo(
    () => (details && !isPrSidebarDetailsPlaceholder(details) ? details.comments : []),
    [details]
  )
  const isPr = details != null && !detailsFailed && details.item.type === 'pr'

  // Per-card action bundle (stable callbacks from the hook) — built once so the
  // memo'd cards don't re-render on unrelated timeline changes.
  const cardActions = useMemo<PRCommentCardActions | undefined>(
    () =>
      actions && isPr
        ? {
            reply: actions.reply,
            toggleResolve: actions.toggleResolve,
            editComment: actions.editComment,
            deleteComment: actions.deleteComment,
            isReplyBusy: actions.isReplyBusy,
            isResolveBusy: actions.isResolveBusy,
            isEditBusy: actions.isEditBusy,
            isDeleteBusy: actions.isDeleteBusy,
            prRepo: prRepo ?? null
          }
        : undefined,
    [actions, isPr, prRepo]
  )
  const canComment = isPr && actions !== undefined && canAddRootComment(prState)

  const [filter, setFilter] = useState<PRCommentAudienceFilter>('all')
  const counts = useMemo(
    () => getPRCommentAudienceCounts(comments, botAuthorOverrides),
    [botAuthorOverrides, comments]
  )
  const visible = useMemo(
    () => filterPRCommentsByAudience(comments, filter, botAuthorOverrides),
    [botAuthorOverrides, comments, filter]
  )
  const groups = useMemo(() => groupPRComments(visible), [visible])

  // Bounded render window; reset to the first page when the user selects another filter.
  const [limit, setLimit] = useState(COMMENT_PAGE)
  const selectFilter = (nextFilter: PRCommentAudienceFilter): void => {
    if (nextFilter === filter) {
      return
    }
    // Why: paging belongs to the filter-tab event, so reset it in the same batch
    // instead of briefly rendering the new filter with the previous page size.
    setLimit(COMMENT_PAGE)
    setFilter(nextFilter)
  }
  const shownGroups = groups.slice(0, limit)
  const remaining = groups.length - shownGroups.length

  return (
    <>
      <PRSection title={t('prcommentsSection.description')}>
        {loadingDetails ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : detailsFailed ? (
          <Text style={styles.noDescription}>{t('prcommentsSection.couldNotLoadDescription')}</Text>
        ) : body.trim() ? (
          <CommentMarkdown content={body} variant="document" />
        ) : (
          <Text style={styles.noDescription}>{t('prcommentsSection.noDescription')}</Text>
        )}
      </PRSection>

      <PRSection
        title={t('prcommentsSection.comments')}
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
        ) : detailsFailed ? (
          <Text style={styles.empty}>{t('prcommentsSection.couldNotLoadComments')}</Text>
        ) : (
          <View style={styles.list}>
            {comments.length === 0 ? (
              <Text style={styles.empty}>{t('prcommentsSection.noComments')}</Text>
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
                          onPress={() => selectFilter(tab.value)}
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
                  <>
                    {shownGroups.map((group) => (
                      <CommentGroupView
                        key={getPRCommentGroupId(group)}
                        group={group}
                        actions={cardActions}
                      />
                    ))}
                    {remaining > 0 ? (
                      <Pressable
                        style={styles.showMore}
                        onPress={() => setLimit((l) => l + COMMENT_PAGE)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.showMoreText}>
                          {remaining > COMMENT_PAGE
                            ? t('prcommentsSection.showVisible', {
                                visibleCommentCount: COMMENT_PAGE,
                                remaining: remaining
                              })
                            : t('prcommentsSection.showRemaining', {
                                remainingCommentCount: remaining
                              })}
                        </Text>
                      </Pressable>
                    ) : null}
                  </>
                )}
              </>
            )}
            {actions?.error ? <Text style={styles.actionError}>{actions.error}</Text> : null}
            {canComment && actions ? (
              <View style={styles.rootComposer}>
                <PRCommentComposer
                  placeholder={t('prcommentsSection.add')}
                  submitLabel={t('prcommentsSection.comment')}
                  submitting={actions.isRootBusy}
                  onSubmit={actions.addRootComment}
                />
              </View>
            ) : null}
          </View>
        )}
      </PRSection>
    </>
  )
}

function CommentGroupView({
  group,
  actions
}: {
  group: PRCommentGroup
  actions?: PRCommentCardActions
}) {
  const [expanded, setExpanded] = useState(false)
  const cards =
    group.kind === 'thread'
      ? [
          <PRCommentCard key={group.root.id} comment={group.root} actions={actions} />,
          ...group.replies.map((reply) => (
            <PRCommentCard key={reply.id} comment={reply} isReply actions={actions} />
          ))
        ]
      : [<PRCommentCard key={group.comment.id} comment={group.comment} actions={actions} />]

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
          {count > 1
            ? t(
                group.kind === 'thread'
                  ? 'prcommentsSection.resolvedThreadAuthorReply'
                  : 'prcommentsSection.resolvedCommentAuthorReply',
                {
                  author: root.author,
                  replyCount: count
                }
              )
            : t(
                group.kind === 'thread'
                  ? 'prcommentsSection.resolvedThreadAuthor'
                  : 'prcommentsSection.resolvedCommentAuthor',
                {
                  author: root.author
                }
              )}
        </Text>
      </Pressable>
      {expanded ? <View style={shared.sectionBody}>{cards}</View> : null}
    </View>
  )
}
