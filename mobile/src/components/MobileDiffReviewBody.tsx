import { useMemo, useState } from 'react'
import { FlatList, Pressable, Text } from 'react-native'
import { ChevronsUpDown, FileText, ListChecks } from 'lucide-react-native'
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
import {
  buildMobileDiffReviewRows,
  type MobileDiffReviewRow
} from '../session/mobile-diff-review-rows'
import { colors } from '../theme/mobile-theme'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from '../session/mobile-diff-review-queue'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

type Props = {
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  currentItem: MobileDiffReviewQueueItem | null
  diffState: ReviewDiffState
  filteredCount: number
  screenState: ReviewScreenState
  staleCommentIds: ReadonlySet<string>
  onAddNote: (lineNumber: number) => void
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
  onAddNote,
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
      {...(currentItem?.scope === 'commit' ? {} : { onAddNote })}
      onEditNote={onEditNote}
    />
  )
}

const NO_OPENED_LINES: ReadonlySet<number> = new Set()

// Keyed by file, so folds the reader opened close again on the next file.
function MobileDiffReviewLines({
  lines,
  truncated,
  commentsByLine,
  staleCommentIds,
  onAddNote,
  onEditNote
}: {
  lines: ReviewDiffLine[]
  truncated: boolean
  commentsByLine: ReadonlyMap<number, DiffComment[]>
  staleCommentIds: ReadonlySet<string>
  onAddNote?: (lineNumber: number) => void
  onEditNote: (comment: DiffComment) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Opened folds are line indexes into this load; a reload with new lines starts folded again.
  const [opened, setOpened] = useState<{ lines: ReviewDiffLine[]; indexes: ReadonlySet<number> }>(
    () => ({ lines, indexes: new Set() })
  )
  const openedLines = opened.lines === lines ? opened.indexes : NO_OPENED_LINES
  const rows = useMemo(
    () => buildMobileDiffReviewRows(lines, openedLines, new Set(commentsByLine.keys())),
    [commentsByLine, lines, openedLines]
  )
  return (
    <FlatList<MobileDiffReviewRow<ReviewDiffLine>>
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item: row }) =>
        row.kind === 'fold' ? (
          <Pressable
            style={({ pressed }) => [styles.foldRow, pressed && styles.buttonPressed]}
            onPress={() => {
              const next = new Set(openedLines)
              for (let index = row.startIndex; index < row.endIndex; index += 1) {
                next.add(index)
              }
              setOpened({ lines, indexes: next })
            }}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.diffReviewBody.showUnchangedLines',
              'Show {{count}} unchanged lines',
              { count: row.hiddenCount }
            )}
          >
            <ChevronsUpDown size={13} color={colors.textMuted} strokeWidth={2.2} />
            <Text style={styles.foldText}>
              {row.hiddenCount === 1
                ? t('components.diffReviewBody.unchangedLines_one', '{{count}} unchanged line', {
                    count: row.hiddenCount
                  })
                : t('components.diffReviewBody.unchangedLines_other', '{{count}} unchanged lines', {
                    count: row.hiddenCount
                  })}
            </Text>
          </Pressable>
        ) : (
          <MobileDiffReviewLine
            line={row.line}
            comments={commentsByLine.get(row.line.newLineNumber ?? -1) ?? []}
            staleCommentIds={staleCommentIds}
            onAddNote={onAddNote}
            onEditNote={onEditNote}
          />
        )
      }
      contentContainerStyle={styles.diffList}
      ListFooterComponent={
        truncated ? (
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
