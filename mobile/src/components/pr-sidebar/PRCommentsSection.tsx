import { Fragment, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import type { PRState } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import { colors } from '../../theme/mobile-theme'
import { canAddRootComment } from '../../session/pr-comment-actions'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import type { MobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import { MobileSegmentedControl } from '../MobileSegmentedControl'
import { Button } from '../ui/Button'
import { Collapsible } from '../ui/Collapsible'
import { slideTransition } from '../ui/transition-styles'
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
  PR_COMMENT_AUDIENCE_FILTERS,
  getPRCommentAudienceEmptyLabel
} from './pr-comment-audience-labels'
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
  // Repo slug for the slug-addressed comment edit/delete RPCs; threaded into the
  // per-card actions so the edit/delete affordances can gate on its presence.
  prRepo?: GitHubPrRepoSlug | null
  // Interactive comment actions (reply/resolve/add/edit/delete). Absent (e.g.
  // non-PR) leaves the timeline read-only.
  actions?: MobilePrCommentActions
  // Author logins manually marked as bots on desktop; keeps the Humans/Bots
  // tabs classifying the same comments as the desktop panel.
  botAuthorOverrides?: ReadonlySet<string>
  // Re-fetches the PR when its details failed to load.
  onRetry?: () => void
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
  botAuthorOverrides,
  onRetry
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
  const now = useNow(60_000, comments.length > 0)

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

  const retry = onRetry ? <Button label="Retry" size="compact" onPress={onRetry} /> : null
  const segments = PR_COMMENT_AUDIENCE_FILTERS.map((tab) => ({
    value: tab.value,
    label: `${tab.label} ${counts[tab.value]}`
  }))

  return (
    <>
      <PRSection title="Description">
        {loadingDetails ? (
          <ActivityIndicator color={colors.textSecondary} style={styles.spinner} />
        ) : detailsFailed ? (
          <View style={styles.failedRow}>
            <Text style={styles.noDescription}>Couldn't load the description.</Text>
            {retry}
          </View>
        ) : body.trim() ? (
          <CommentMarkdown content={body} variant="document" />
        ) : (
          <Text style={styles.noDescription}>No description provided.</Text>
        )}
      </PRSection>

      <PRSection
        title="Comments"
        count={comments.length > 0 ? comments.length : undefined}
        layout="bare"
      >
        {loadingDetails ? (
          <View style={[styles.thread, shared.noteRow]}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={shared.noteRowText}>Loading comments…</Text>
          </View>
        ) : detailsFailed ? (
          <View style={[styles.thread, shared.noteRow]}>
            <Text style={shared.noteRowText}>Couldn't load comments.</Text>
            {retry}
          </View>
        ) : (
          <>
            {comments.length === 0 ? (
              <View style={[styles.thread, shared.noteRow]}>
                <Text style={shared.noteRowText}>No comments yet.</Text>
              </View>
            ) : (
              <>
                {isPr ? (
                  <MobileSegmentedControl
                    segments={segments}
                    selected={filter}
                    onSelect={selectFilter}
                    fill
                  />
                ) : null}
                {visible.length === 0 ? (
                  <View style={[styles.thread, shared.noteRow]}>
                    <Text style={shared.noteRowText}>{getPRCommentAudienceEmptyLabel(filter)}</Text>
                  </View>
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
                      <Button
                        label={`Show ${Math.min(remaining, COMMENT_PAGE)} more${
                          remaining > COMMENT_PAGE ? ` of ${remaining}` : ''
                        }`}
                        size="compact"
                        onPress={() => setLimit((l) => l + COMMENT_PAGE)}
                        style={styles.showMore}
                      />
                    ) : null}
                  </>
                )}
              </>
            )}
            {actions?.error ? <Text style={styles.actionError}>{actions.error}</Text> : null}
            {canComment && actions ? (
              <PRCommentComposer
                placeholder="Add a comment…"
                submitLabel="Comment"
                submitting={actions.isRootBusy}
                onSubmit={actions.addRootComment}
              />
            ) : null}
          </>
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

  const thread = cards.map((card, index) => (
    <Fragment key={card.key}>
      {index > 0 ? <View style={styles.separator} /> : null}
      {card}
    </Fragment>
  ))

  if (!isResolvedPRCommentGroup(group)) {
    return <View style={styles.thread}>{thread}</View>
  }

  // Resolved threads collapse behind a summary row (desktop accordion parity).
  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <View style={styles.thread}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        {({ pressed }) => (
          <View style={[shared.noteRow, pressed && shared.rowPressed]}>
            <View style={[expanded ? shared.chevronOpen : shared.chevronClosed, slideTransition]}>
              <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
            </View>
            <Text style={shared.noteRowText} numberOfLines={1}>
              Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {root.author}
              {count > 1 ? ` (${count})` : ''}
            </Text>
          </View>
        )}
      </Pressable>
      <Collapsible open={expanded}>
        <View style={styles.separator} />
        {thread}
      </Collapsible>
    </View>
  )
}
