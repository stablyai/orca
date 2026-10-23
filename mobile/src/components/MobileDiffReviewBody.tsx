import { FlatList, Text } from 'react-native'
import { AlertCircle, FileX, ListFilter, type LucideIcon } from 'lucide-react-native'
import type { RefObject } from 'react'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { MobileDiffReviewLine } from './MobileDiffReviewLine'
import type {
  ReviewDiffLine,
  ReviewDiffState,
  ReviewScreenState
} from '../session/mobile-diff-review-screen-model'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { StateView } from './ui/StateView'

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
  onRetry
}: Props) {
  if (screenState.kind === 'loading') {
    return <StateView loading title="Loading review…" />
  }
  if (screenState.kind === 'error' || screenState.kind === 'unavailable') {
    return (
      <CenteredState
        icon={AlertCircle}
        title={
          screenState.kind === 'unavailable' ? 'Review unavailable' : 'Couldn’t load the review'
        }
        text={screenState.message}
        onRetry={onRetry}
      />
    )
  }
  if (filteredCount === 0) {
    return (
      <CenteredState
        icon={ListFilter}
        title="No files to review"
        text="Nothing matches this filter. Try another one."
      />
    )
  }
  if (diffState.kind === 'loading') {
    return <StateView loading title="Loading diff…" />
  }
  if (diffState.kind !== 'ready') {
    return <DiffUnavailableState diffState={diffState} onRetry={onRetry} />
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
      ListHeaderComponent={<Text style={styles.diffHint}>Long-press a line to add a note.</Text>}
      ListFooterComponent={
        diffState.truncated ? (
          <Text style={styles.truncatedText}>Diff truncated for mobile preview.</Text>
        ) : null
      }
    />
  )
}

function DiffUnavailableState({
  diffState,
  onRetry
}: {
  diffState: ReviewDiffState
  onRetry: (() => void) | undefined
}) {
  const title =
    diffState.kind === 'binary'
      ? 'Binary file'
      : diffState.kind === 'too-large'
        ? 'Diff too large'
        : diffState.kind === 'deleted'
          ? 'File deleted'
          : 'Diff unavailable'
  const text =
    diffState.kind === 'binary'
      ? 'This file can’t be shown as text on mobile.'
      : diffState.kind === 'too-large'
        ? 'This diff is too large for the mobile preview.'
        : diffState.kind === 'deleted'
          ? 'This file was deleted. Add a file note or mark it reviewed.'
          : diffState.kind === 'error'
            ? diffState.message
            : 'Select a file to review.'
  return (
    <CenteredState
      icon={diffState.kind === 'error' ? AlertCircle : FileX}
      title={title}
      text={text}
      onRetry={onRetry}
    />
  )
}

function CenteredState({
  icon,
  title,
  text,
  onRetry
}: {
  icon: LucideIcon
  title: string
  text: string
  onRetry?: () => void
}) {
  return (
    <StateView
      icon={icon}
      title={title}
      message={text}
      primary={onRetry ? { label: 'Retry', onPress: onRetry } : undefined}
    />
  )
}
