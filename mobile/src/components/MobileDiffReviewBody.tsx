import { FileText, ListChecks } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { MobileLoadErrorState, MobileOfflineState, MobileStateView } from './MobileStateView'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileDiffReviewLines, type LineRange } from './MobileDiffReviewLines'
import type { ReviewDiffState, ReviewScreenState } from '../session/mobile-diff-review-screen-model'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from '../session/mobile-diff-review-queue'
import type { MobileDiffReviewThread } from '../session/mobile-diff-review-github'
import type { PRCommentCardActions } from './pr-sidebar/PRCommentCard'

type Props = {
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  currentItem: MobileDiffReviewQueueItem | null
  diffState: ReviewDiffState
  filteredCount: number
  screenState: ReviewScreenState
  staleCommentIds: ReadonlySet<string>
  threadsByLine: ReadonlyMap<number, readonly MobileDiffReviewThread[]>
  threadActions: PRCommentCardActions | undefined
  selectedRange: LineRange | null
  onPickLines: (range: LineRange) => void
  /** Scroll to this line once, then report it done. */
  scrollToLine: number | null
  onScrolledToLine: () => void
  onEditNote: (comment: DiffComment) => void
  onRetry: (() => void) | undefined
  /** The host is unreachable, so a failed load is a wait rather than an error. */
  offline: boolean
  /** The section this screen walks; an empty one means the reader finished it. */
  filter: MobileDiffReviewQueueFilter
  onBack: () => void
}

export function MobileDiffReviewBody({
  commentsByLine,
  currentItem,
  diffState,
  filteredCount,
  screenState,
  staleCommentIds,
  threadsByLine,
  threadActions,
  selectedRange,
  onPickLines,
  scrollToLine,
  onScrolledToLine,
  onEditNote,
  onRetry,
  offline,
  filter,
  onBack
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (screenState.kind === 'loading') {
    return (
      <MobileStateView
        loading
        title={t('components.diffReviewBody.loadingReview', 'Loading review...')}
      />
    )
  }
  if (screenState.kind === 'unavailable') {
    return (
      <MobileStateView
        icon={ListChecks}
        title={t('components.diffReviewBody.reviewUnavailable', 'Review Unavailable')}
        message={screenState.message}
      />
    )
  }
  if (screenState.kind === 'error') {
    return offline ? (
      <MobileOfflineState onReconnect={onRetry} />
    ) : (
      <MobileLoadErrorState
        title={t('components.diffReviewBody.loadFailed', 'Unable to Load Review')}
        error={screenState.message}
        onRetry={onRetry}
      />
    )
  }
  if (filteredCount === 0) {
    return (
      <MobileStateView
        icon={ListChecks}
        title={
          filter === 'unstaged'
            ? t('components.diffReviewBody.allStaged', 'Everything is staged')
            : t('components.diffReviewBody.noReviewableChanges', 'No Reviewable Changes')
        }
        action={{ label: t('common.back', 'Back'), onPress: onBack }}
      />
    )
  }
  if (diffState.kind === 'loading') {
    return (
      <MobileStateView
        loading
        title={t('components.diffReviewBody.loadingDiff', 'Loading diff...')}
      />
    )
  }
  if (diffState.kind === 'error') {
    return offline ? (
      <MobileOfflineState onReconnect={onRetry} />
    ) : (
      <MobileLoadErrorState error={diffState.message} onRetry={onRetry} />
    )
  }
  if (diffState.kind !== 'ready') {
    return <DiffUnavailableState diffState={diffState} />
  }
  return (
    <MobileDiffReviewLines
      key={diffState.itemKey}
      lines={diffState.lines}
      truncated={diffState.truncated}
      commentsByLine={commentsByLine}
      staleCommentIds={staleCommentIds}
      threadsByLine={threadsByLine}
      threadActions={threadActions}
      selectedRange={selectedRange}
      scrollToLine={scrollToLine}
      onScrolledToLine={onScrolledToLine}
      {...(currentItem?.scope === 'commit' ? {} : { onPickLines })}
      onEditNote={onEditNote}
    />
  )
}

/** Binary, oversize and deleted diffs: nothing to retry, so no action. */
function DiffUnavailableState({ diffState }: { diffState: ReviewDiffState }) {
  const t = useMobileTranslation()
  const title =
    diffState.kind === 'binary'
      ? t('components.diffReviewBody.binaryDiff', 'Binary Diff')
      : diffState.kind === 'too-large'
        ? t('components.diffReviewBody.diffTooLarge', 'Diff Too Large')
        : diffState.kind === 'deleted'
          ? t('components.diffReviewBody.deletedFile', 'Deleted File')
          : t('components.diffReviewBody.diffUnavailable', 'Diff Unavailable')
  const text =
    diffState.kind === 'binary'
      ? t(
          'components.diffReviewBody.binaryMessage',
          'This file cannot be rendered as text on mobile.'
        )
      : diffState.kind === 'too-large'
        ? t(
            'components.diffReviewBody.tooLargeMessage',
            'This diff is too large for the mobile preview.'
          )
        : diffState.kind === 'deleted'
          ? t(
              'components.diffReviewBody.deletedMessage',
              'This file was deleted. Add a file note or mark it reviewed.'
            )
          : t('components.diffReviewBody.selectFile', 'Select a file to review.')
  return <MobileStateView icon={FileText} title={title} message={text} />
}
