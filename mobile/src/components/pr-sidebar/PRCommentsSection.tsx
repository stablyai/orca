import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import type { PRState } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { canAddRootComment } from '../../session/pr-comment-actions'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import type { MobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import { PRSection } from './PRSection'
import { CommentMarkdown } from './CommentMarkdown'
import { PRCommentCard, type PRCommentCardActions } from './PRCommentCard'
import { PRCommentComposer } from './PRCommentComposer'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../../src/shared/pr-comment-audience'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  type PRCommentGroup
} from '../../../../src/shared/pr-comment-groups'
import { prCommentsStyles as styles } from './pr-comments-styles'
import { mobilePrSidebarStyles as shared } from './mobile-pr-sidebar-styles'
import { useNow } from '../../hooks/use-now'

type Props = {
  details: GitHubWorkItemDetails | null
  // The PR conversation state — gates the root-comment composer (open PRs only).
  prState: PRState | null
  // Thread repo slug into card actions; edit/delete require it.
  prRepo?: GitHubPrRepoSlug | null
  // Omit actions to keep timeline read-only outside interactive PR.
  actions?: MobilePrCommentActions
  // Honor desktop’s manually marked bot logins so audience tabs classify identically.
  botAuthorOverrides?: ReadonlySet<string>
}

// Page comments in chunks: nested ScrollView cannot virtualize, and eager Markdown parse of whole timeline can ANR JS thread.
const COMMENT_PAGE = 12

function audienceFilters(t: Translate): { value: PRCommentAudienceFilter; label: string }[] {
  return [
    { value: 'all', label: t('pullRequest.commentsSection.all', 'All') },
    { value: 'human', label: t('pullRequest.commentsSection.humans', 'Humans') },
    { value: 'bot', label: t('pullRequest.commentsSection.bots', 'Bots') }
  ]
}

function audienceEmptyLabel(filter: PRCommentAudienceFilter, t: Translate): string {
  switch (filter) {
    case 'bot':
      return t('pullRequest.commentsSection.noBotComments', 'No bot comments.')
    case 'human':
      return t('pullRequest.commentsSection.noHumanComments', 'No human comments.')
    case 'all':
      return t('pullRequest.commentsSection.noComments', 'No comments yet.')
  }
}

// Match desktop description/timeline with audience filter, threaded review replies, reactions and collapsible resolved threads.
export function PRCommentsSection({
  details,
  prState,
  prRepo,
  actions,
  botAuthorOverrides
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Null details means phase 2 loading; synthetic placeholder means failure, never empty success.
  const loadingDetails = details === null
  const detailsFailed = details != null && isPrSidebarDetailsPlaceholder(details)
  const body = details?.body ?? ''
  const comments = useMemo(
    () => (details && !isPrSidebarDetailsPlaceholder(details) ? details.comments : []),
    [details]
  )
  const isPr = details != null && !detailsFailed && details.item.type === 'pr'

  // Memoize stable per-card callback bundles so unrelated timeline updates skip cards.
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
  const now = useNow(60_000, comments.length > 0)

  const [limit, setLimit] = useState(COMMENT_PAGE)
  const selectFilter = (nextFilter: PRCommentAudienceFilter): void => {
    if (nextFilter === filter) {
      return
    }
    // Reset page limit in filter event’s batch to avoid first rendering new audience with old page size.
    setLimit(COMMENT_PAGE)
    setFilter(nextFilter)
  }
  const shownGroups = groups.slice(0, limit)
  const remaining = groups.length - shownGroups.length
  const count = Math.min(remaining, COMMENT_PAGE)

  return (
    <>
      <PRSection title={t('pullRequest.commentsSection.description', 'Description')}>
        {loadingDetails ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : detailsFailed ? (
          <Text style={styles.noDescription}>
            {t(
              'pullRequest.commentsSection.descriptionLoadFailed',
              'Could not load description. Tap refresh to try again.'
            )}
          </Text>
        ) : body.trim() ? (
          <CommentMarkdown content={body} variant="document" />
        ) : (
          <Text style={styles.noDescription}>
            {t('pullRequest.commentsSection.noDescription', 'No description provided.')}
          </Text>
        )}
      </PRSection>

      <PRSection
        title={t('pullRequest.commentsSection.title', 'Comments')}
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
          <Text style={styles.empty}>
            {t(
              'pullRequest.commentsSection.commentsLoadFailed',
              'Could not load comments. Tap refresh to try again.'
            )}
          </Text>
        ) : (
          <View style={styles.list}>
            {comments.length === 0 ? (
              <Text style={styles.empty}>
                {t('pullRequest.commentsSection.noComments', 'No comments yet.')}
              </Text>
            ) : (
              <>
                {isPr ? (
                  <View style={styles.audienceTabs}>
                    {audienceFilters(t).map((tab) => {
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
                  <Text style={styles.empty}>{audienceEmptyLabel(filter, t)}</Text>
                ) : (
                  <>
                    {shownGroups.map((group) => (
                      <CommentGroupView
                        key={getPRCommentGroupId(group)}
                        group={group}
                        actions={cardActions}
                        now={now}
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
                            ? t(
                                'pullRequest.commentsSection.showMoreOf',
                                'Show {{count}} more of {{remaining}}',
                                { count, remaining }
                              )
                            : t('pullRequest.commentsSection.showMore', 'Show {{count}} more', {
                                count
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
                  placeholder={t(
                    'pullRequest.commentsSection.addCommentPlaceholder',
                    'Add a comment…'
                  )}
                  submitLabel={t('pullRequest.commentsSection.comment', 'Comment')}
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
  actions,
  now
}: {
  group: PRCommentGroup
  actions?: PRCommentCardActions
  now: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const cards =
    group.kind === 'thread'
      ? [
          <PRCommentCard key={group.root.id} comment={group.root} actions={actions} now={now} />,
          ...group.replies.map((reply) => (
            <PRCommentCard key={reply.id} comment={reply} isReply actions={actions} now={now} />
          ))
        ]
      : [
          <PRCommentCard
            key={group.comment.id}
            comment={group.comment}
            actions={actions}
            now={now}
          />
        ]

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
          {group.kind === 'thread'
            ? count === 1
              ? t(
                  'pullRequest.commentsSection.resolvedThreadSingle',
                  'Resolved thread by {{author}}',
                  { author: root.author }
                )
              : t(
                  'pullRequest.commentsSection.resolvedThreadCount',
                  'Resolved thread by {{author}} ({{count}})',
                  { author: root.author, count }
                )
            : count === 1
              ? t(
                  'pullRequest.commentsSection.resolvedCommentSingle',
                  'Resolved comment by {{author}}',
                  { author: root.author }
                )
              : t(
                  'pullRequest.commentsSection.resolvedCommentCount',
                  'Resolved comment by {{author}} ({{count}})',
                  { author: root.author, count }
                )}
        </Text>
      </Pressable>
      {expanded ? <View style={shared.sectionBody}>{cards}</View> : null}
    </View>
  )
}
