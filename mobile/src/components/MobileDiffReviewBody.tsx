import { FlatList, Text } from 'react-native'
import { FileText, ListChecks } from 'lucide-react-native'
import type { RefObject } from 'react'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { MobileLoadErrorState, MobileOfflineState, MobileStateView } from './MobileStateView'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileDiffReviewLine } from './MobileDiffReviewLine'
import type {
  ReviewDiffLine,
  ReviewDiffState,
  ReviewScreenState
} from '../session/mobile-diff-review-screen-model'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  activeHunkIndex: number | null
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  currentItem: MobileDiffReviewQueueItem | null
  diffState: ReviewDiffState
  filteredCount: number
  listRef: RefObject<FlatList<ReviewDiffLine> | null>
  screenState: ReviewScreenState
  staleCommentIds: ReadonlySet<string>
  onAddNote: (lineNumber: number) => void
  onEditNote: (comment: DiffComment) => void
  onRetry: (() => void) | undefined
  /** The host is unreachable, so a failed load is a wait rather than an error. */
  offline: boolean
  /** Clears a narrowing review filter; absent when already showing everything. */
  onShowAll?: () => void
}

export function MobileDiffReviewBody({
  activeHunkIndex,
  commentsByLine,
  currentItem,
  diffState,
  filteredCount,
  listRef,
  screenState,
  staleCommentIds,
  onAddNote,
  onEditNote,
  onRetry,
  offline,
  onShowAll
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
        title={t('components.diffReviewBody.noReviewableChanges', 'No Reviewable Changes')}
        message={
          onShowAll
            ? t('components.diffReviewBody.tryDifferentFilter', 'Try a different review filter.')
            : null
        }
        action={
          onShowAll
            ? { label: t('components.diffReviewBody.showAll', 'Show all'), onPress: onShowAll }
            : null
        }
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
    <FlatList
      ref={listRef}
      data={diffState.lines}
      keyExtractor={(_, index) => `${currentItem?.key ?? 'diff'}:${index}`}
      renderItem={({ item, index }) => {
        const lineNumber = item.newLineNumber ?? -1
        const active =
          activeHunkIndex !== null &&
          index >= (diffState.hunks[activeHunkIndex]?.startIndex ?? -1) &&
          index <= (diffState.hunks[activeHunkIndex]?.endIndex ?? -1)
        return (
          <MobileDiffReviewLine
            line={item}
            comments={commentsByLine.get(lineNumber) ?? []}
            staleCommentIds={staleCommentIds}
            active={active}
            onAddNote={onAddNote}
            onEditNote={onEditNote}
          />
        )
      }}
      contentContainerStyle={styles.diffList}
      onScrollToIndexFailed={(info) => {
        listRef.current?.scrollToOffset({
          offset: Math.max(0, info.averageItemLength * info.index),
          animated: true
        })
      }}
      ListFooterComponent={
        diffState.truncated ? (
          <Text style={styles.truncatedText}>
            {t('components.diffReviewBody.diffTruncated', 'Diff truncated for mobile preview.')}
          </Text>
        ) : null
      }
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
