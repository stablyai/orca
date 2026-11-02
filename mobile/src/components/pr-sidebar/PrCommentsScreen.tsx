import { useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Bot, ListFilter } from 'lucide-react-native'
import { colors, pressedStyle, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  groupPRComments,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  type PRCommentGroup
} from '../../../../src/shared/pr-comment-groups'
import { isBotPRComment } from '../../../../src/shared/pr-comment-audience'
import { canAddRootComment } from '../../session/pr-comment-actions'
import { buildPRCommentsResolutionPrompt } from '../../../../src/shared/github/pr-comments-resolution-prompt'
import { useMobileLaunchAgentLabel } from '../../session/use-mobile-launch-agent-label'
import { useHostProtocolGates } from '../host-protocol-gates-context'
import { AgentLaunchNotice } from '../AgentLaunchNotice'
import { useNow } from '../../hooks/use-now'
import { useKeyboardOcclusion } from '../../platform/keyboard-occlusion'
import { useBackClaim } from '../../navigation/use-back-claim'
import { NavBarButton } from '../nav-bar/NavBarButton'
import { PullDownMenu } from '../nav-bar/PullDownMenu'
import { MobileSegmentedControl } from '../MobileSegmentedControl'
import { SectionHeader } from '../list/ListGroup'
import { MobileLoadErrorState, MobileStateView } from '../MobileStateView'
import { PrThreadRow, type PrAskToFix, type PrThreadActions } from './PrThreadRow'
import { PrThreadScreen } from './PrThreadScreen'
import { PRCommentComposer } from './PRCommentComposer'
import { NotReady, ScreenFrame, type ScreenProps } from './pr-tab-screen-frame'
import { livePrDetails, readyPrData } from './use-mobile-pr-tab'

type CommentsFilter = 'unresolved' | 'all'
// Each row parses Markdown; page so a long timeline cannot stall the JS thread.
const COMMENT_PAGE = 12

export function PrCommentsScreen({ tab, onBack, bottomInset = 0, onOpenFile }: ScreenProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const data = readyPrData(tab)
  const details = livePrDetails(data?.details ?? null)
  const now = useNow(60_000)
  const groups = useMemo(() => groupPRComments(details?.comments ?? []), [details])
  const unresolved = groups.filter(isUnresolvedThread)
  const [filter, setFilter] = useState<CommentsFilter>(() =>
    unresolved.length > 0 ? 'unresolved' : 'all'
  )
  const [hideBots, setHideBots] = useState(false)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const filterRef = useRef<View>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [resolvedLimit, setResolvedLimit] = useState(COMMENT_PAGE)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [focusReply, setFocusReply] = useState(false)
  const keyboardHeight = useKeyboardOcclusion()
  const [limit, setLimit] = useState(COMMENT_PAGE)
  // A failed refresh leaves no details: close the thread so the list's error and Retry show, and it cannot pop back later.
  if (openThreadId !== null && details === null) {
    setOpenThreadId(null)
  }
  const threadShown = openThreadId !== null && details !== null
  useBackClaim(
    threadShown
      ? () => {
          setOpenThreadId(null)
          return true
        }
      : null
  )
  const notBot = (group: PRCommentGroup) =>
    !hideBots || !isBotPRComment(getPRCommentGroupRoot(group), tab.botAuthorOverrides)
  const open = (filter === 'unresolved' ? unresolved : groups.filter((g) => !isResolvedGroup(g)))
    .filter(notBot)
    // Unresolved threads lead; conversation comments follow in timeline order.
    .sort((a, b) => Number(isUnresolvedThread(b)) - Number(isUnresolvedThread(a)))
  const resolved = filter === 'all' ? groups.filter(isResolvedGroup).filter(notBot) : []
  const shown = open.slice(0, limit)
  const { commentActions } = tab
  const isPr = details?.item.type === 'pr'
  const rowActions = useMemo<PrThreadActions | undefined>(
    () =>
      isPr
        ? {
            reply: commentActions.reply,
            toggleResolve: commentActions.toggleResolve,
            editComment: commentActions.editComment,
            deleteComment: commentActions.deleteComment,
            isReplyBusy: commentActions.isReplyBusy,
            isResolveBusy: commentActions.isResolveBusy,
            isEditBusy: commentActions.isEditBusy,
            isDeleteBusy: commentActions.isDeleteBusy,
            prRepo: data?.pr.prRepo ?? null
          }
        : undefined,
    [commentActions, data?.pr.prRepo, isPr]
  )
  const canComment = isPr && canAddRootComment(data?.pr.state ?? null)
  const { hostCapabilities } = useHostProtocolGates()
  const hasBotFindings = unresolved.some((group) =>
    isBotPRComment(getPRCommentGroupRoot(group), tab.botAuthorOverrides)
  )
  const askAgent = useMobileLaunchAgentLabel({
    client: tab.client,
    worktreeId: tab.worktreeId,
    hostCapabilities,
    actionId: 'resolveComments',
    enabled: hasBotFindings
  })
  const askNotice = tab.triage.noticeFor('resolve-comments')
  // One bot finding per launch, through desktop's own Resolve comments prompt.
  const askToFix = (group: PRCommentGroup): PrAskToFix | undefined =>
    data
      ? {
          label: askAgent
            ? t('pullRequest.screens.askToFix', 'Ask {{agent}} to fix', { agent: askAgent })
            : t('pullRequest.screens.askAiToFix', 'Ask AI to fix'),
          busy: tab.triage.isBusy('resolve-comments'),
          disabled: tab.triage.availability !== 'available',
          onPress: () =>
            void tab.triage.launch('resolve-comments', () =>
              buildPRCommentsResolutionPrompt({
                reviewKind: 'PR',
                reviewNumber: data.pr.number,
                reviewTitle: data.pr.title,
                reviewUrl: data.pr.url,
                groups: [group]
              })
            )
        }
      : undefined
  const openThread =
    openThreadId === null
      ? null
      : (groups.find(
          (group): group is Extract<PRCommentGroup, { kind: 'thread' }> =>
            group.kind === 'thread' && group.threadId === openThreadId
        ) ?? null)
  const row = (group: PRCommentGroup) => (
    <PrThreadRow
      key={getPRCommentGroupId(group)}
      group={group}
      actions={rowActions}
      botAuthorOverrides={tab.botAuthorOverrides}
      now={now}
      onOpenFile={onOpenFile}
      onOpenThread={
        group.kind === 'thread'
          ? (focus) => {
              setFocusReply(focus)
              setOpenThreadId(group.threadId)
            }
          : undefined
      }
      askToFix={askToFix(group)}
    />
  )

  return (
    <View style={styles.layer}>
      {/* Covered by the thread, the list leaves the accessibility tree so VoiceOver reads only the thread. */}
      <View
        style={styles.layer}
        aria-hidden={threadShown}
        importantForAccessibility={threadShown ? 'no-hide-descendants' : 'auto'}
      >
        <ScreenFrame
          title={t('pullRequest.commentsSection.title', 'Comments')}
          subtitle={data ? `#${data.pr.number}` : undefined}
          onBack={onBack}
          trailing={
            <NavBarButton
              ref={filterRef}
              icon={ListFilter}
              active={hideBots}
              onPress={() => setFilterMenuOpen(true)}
              accessibilityLabel={t('pullRequest.screens.filterComments', 'Filter comments')}
            />
          }
          footer={
            canComment && data ? (
              // The box sits outside the scroll view, so it lifts itself over the keyboard.
              <View
                style={[
                  styles.composerBar,
                  keyboardHeight > 0
                    ? { marginBottom: keyboardHeight, paddingBottom: spacing.sm }
                    : { paddingBottom: Math.max(bottomInset, spacing.md) }
                ]}
              >
                <PRCommentComposer
                  placeholder={t('pullRequest.screens.commentOnPr', 'Comment on #{{number}}…', {
                    number: data.pr.number
                  })}
                  submitLabel={t('pullRequest.commentsSection.comment', 'Comment')}
                  submitting={commentActions.isRootBusy}
                  onSubmit={commentActions.addRootComment}
                  inline
                />
              </View>
            ) : null
          }
        >
          {!data ? (
            <NotReady tab={tab} />
          ) : data.details === null ? (
            <MobileStateView
              loading
              title={t('components.prSidebar.loading', 'Loading pull request…')}
            />
          ) : !details ? (
            <MobileLoadErrorState
              error={t(
                'pullRequest.commentsSection.commentsLoadFailedRetry',
                'Could not load comments.'
              )}
              onRetry={() => tab.refetch({ includeDetails: true })}
            />
          ) : (
            <ScrollView
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              automaticallyAdjustKeyboardInsets
            >
              <MobileSegmentedControl
                tabs
                fill
                style={styles.segments}
                segments={[
                  {
                    value: 'unresolved',
                    label: t('pullRequest.screens.unresolvedCount', 'Unresolved {{count}}', {
                      count: unresolved.length
                    })
                  },
                  {
                    value: 'all',
                    label: t('pullRequest.screens.allCount', 'All {{count}}', {
                      count: groups.length
                    })
                  }
                ]}
                selected={filter}
                onSelect={(value) => {
                  setLimit(COMMENT_PAGE)
                  setFilter(value)
                }}
              />
              {shown.length === 0 && resolved.length === 0 ? (
                <Text style={styles.muted}>
                  {filter === 'unresolved'
                    ? t('pullRequest.screens.noUnresolved', 'No unresolved threads.')
                    : t('pullRequest.commentsSection.noComments', 'No comments yet.')}
                </Text>
              ) : null}
              {shown.map(row)}
              {open.length > shown.length ? (
                <ShowMore
                  count={Math.min(open.length - shown.length, COMMENT_PAGE)}
                  onPress={() => setLimit((value) => value + COMMENT_PAGE)}
                />
              ) : null}
              {resolved.length > 0 ? (
                <View>
                  <SectionHeader
                    title={t('pullRequest.screens.resolvedCount', 'Resolved {{count}}', {
                      count: resolved.length
                    })}
                    expanded={showResolved}
                    onToggle={() => setShowResolved((value) => !value)}
                  />
                  {showResolved ? resolved.slice(0, resolvedLimit).map(row) : null}
                  {showResolved && resolved.length > resolvedLimit ? (
                    <ShowMore
                      count={Math.min(resolved.length - resolvedLimit, COMMENT_PAGE)}
                      onPress={() => setResolvedLimit((value) => value + COMMENT_PAGE)}
                    />
                  ) : null}
                </View>
              ) : null}
              {hasBotFindings ? (
                <View style={styles.notice}>
                  <AgentLaunchNotice
                    availability={tab.triage.availability}
                    success={askNotice.success}
                    error={askNotice.error}
                    warning={askNotice.warning}
                    undeliveredPrompt={askNotice.undeliveredPrompt}
                    errorStyle={styles.noticeError}
                  />
                </View>
              ) : null}
              {commentActions.error ? (
                <Text style={styles.error}>{commentActions.error}</Text>
              ) : null}
            </ScrollView>
          )}
        </ScreenFrame>
      </View>
      <PullDownMenu
        visible={filterMenuOpen}
        anchorRef={filterRef}
        onClose={() => setFilterMenuOpen(false)}
        groups={[
          [
            {
              label: t('pullRequest.screens.hideBots', 'Hide bots'),
              icon: Bot,
              checked: hideBots,
              onPress: () => setHideBots((value) => !value)
            }
          ]
        ]}
      />
      {threadShown ? (
        <View style={styles.threadLayer}>
          <PrThreadScreen
            thread={openThread}
            actions={rowActions}
            error={commentActions.error}
            focusReply={focusReply}
            onOpenFile={onOpenFile}
            now={now}
            onBack={() => setOpenThreadId(null)}
            bottomInset={bottomInset}
          />
        </View>
      ) : null}
    </View>
  )
}

function ShowMore({ count, onPress }: { count: number; onPress: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.showMoreButton, pressed && pressedStyle]}
    >
      <Text style={styles.showMore}>
        {t('pullRequest.commentsSection.showMore', 'Show {{count}} more', { count })}
      </Text>
    </Pressable>
  )
}

function isUnresolvedThread(group: PRCommentGroup): boolean {
  return group.kind === 'thread' && group.root.isResolved !== true
}

function isResolvedGroup(group: PRCommentGroup): boolean {
  return getPRCommentGroupRoot(group).isResolved === true
}

const styles = themedStyleSheet(() => ({
  layer: { flex: 1 },
  threadLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  content: { paddingTop: spacing.sm },
  segments: { marginHorizontal: spacing.lg, marginBottom: spacing.xs },
  muted: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  error: { color: colors.statusRed, fontSize: 13, paddingHorizontal: spacing.lg },
  showMoreButton: { paddingVertical: spacing.md },
  notice: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  noticeError: { color: colors.statusRed, fontSize: 13 },
  showMore: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  composerBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.bgBase
  }
}))
