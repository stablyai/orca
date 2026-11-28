import { useState } from 'react'
import { View } from 'react-native'
import { FileText, ListChecks } from 'lucide-react-native'
import type { DiffComment } from '../../../../../src/shared/file-review/diff-comment-types'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../../../components/feedback/MobileStateView'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { HostUpdateNotice } from '../../../host-update-notice/HostUpdateNotice'
import { MobileDiffReviewLines, type LineRange } from './MobileDiffReviewLines'
import { MobilePanZoomImage } from '../../../files/media/presentation/MobilePanZoomImage'
import { filePreviewStylesSheet } from '../../../files/preview/mobile-file-preview-styles'
import type {
  ReviewDiffState,
  ReviewScreenState
} from '../diff-state/mobile-diff-review-screen-model'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from '../diff-state/mobile-diff-review-queue'
import type { MobileDiffReviewThread } from '../diff-actions/mobile-diff-review-github'
import type { PrThreadActions } from '../pull-request/comments/PrThreadRow'
import { useThemedStyles } from '../../../theme/themed-styles'

type Props = {
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  currentItem: MobileDiffReviewQueueItem | null
  diffState: ReviewDiffState
  filteredCount: number
  screenState: ReviewScreenState
  staleCommentIds: ReadonlySet<string>
  threadsByLine: ReadonlyMap<number, readonly MobileDiffReviewThread[]>
  threadActions: PrThreadActions | undefined
  selectedRange: LineRange | null
  onSelectLines: (range: LineRange | null) => void
  onOpenThread: (threadId: string, focusReply: boolean) => void
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
  onSelectLines,
  onOpenThread,
  scrollToLine,
  onScrolledToLine,
  onEditNote,
  onRetry,
  offline,
  filter,
  onBack
}: Props) {
  const t = useMobileTranslation()
  if (screenState.kind === 'loading') {
    return (
      <MobileStateView
        loading
        title={t('components.diffReviewBody.loadingReview', 'Loading review...')}
      />
    )
  }
  if (screenState.kind === 'unavailable' && screenState.hostUpdate) {
    return <HostUpdateNotice variant="screen" feature={screenState.message} />
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
  if (diffState.kind === 'image') {
    return (
      <DiffImage
        key={diffState.dataUri}
        diffState={diffState}
        title={currentItem?.filePath ?? ''}
      />
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
      {...(currentItem?.scope === 'commit' ? {} : { onSelectLines })}
      onOpenThread={onOpenThread}
      onEditNote={onEditNote}
    />
  )
}

/** Same view as the file tab: the image after the change, or the deleted one. */
function DiffImage({
  diffState,
  title
}: {
  diffState: Extract<ReviewDiffState, { kind: 'image' }>
  title: string
}) {
  const filePreviewStyles = useThemedStyles(filePreviewStylesSheet)
  const t = useMobileTranslation()
  // An image the WebView can't decode stays hidden, so fall back to the binary notice.
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <DiffUnavailableState diffState={{ kind: 'binary', itemKey: diffState.itemKey }} />
  }
  return (
    <View style={filePreviewStyles.imageContainer}>
      <MobilePanZoomImage
        uri={diffState.dataUri}
        onError={() => setFailed(true)}
        label={t('files.filePreviewBody.imageLabel', '{{title}} image', { title })}
      />
    </View>
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
