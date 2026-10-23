import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronUp, MessageSquare } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { colors } from '../theme/mobile-theme'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { MOBILE_GIT_STATUS_LABELS } from '../source-control/mobile-git-status'
import {
  mobileReviewCountLabel,
  mobileReviewScopeLabel,
  type ReviewDiffState
} from '../session/mobile-diff-review-screen-model'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { Badge } from './ui/Badge'
import { IconButton } from './ui/IconButton'

type Props = {
  currentIndex: number
  diffState: ReviewDiffState
  fileNotes: DiffComment[]
  filteredCount: number
  item: MobileDiffReviewQueueItem
  staleCommentIds: ReadonlySet<string>
  onEditNote: (comment: DiffComment) => void
  onJumpHunk: (direction: 'next' | 'previous') => void
}

// Git decoration colours, as desktop and the Commits tab use for file status.
function statusColor(status: MobileDiffReviewQueueItem['status']): string {
  switch (status) {
    case 'added':
    case 'copied':
      return colors.gitDecorationAdded
    case 'deleted':
      return colors.gitDecorationDeleted
    case 'renamed':
      return colors.accentBlue
    case 'untracked':
      return colors.statusAmber
    case 'modified':
    default:
      return colors.textSecondary
  }
}

export function MobileDiffReviewFileSummary({
  currentIndex,
  diffState,
  fileNotes,
  filteredCount,
  item,
  staleCommentIds,
  onEditNote,
  onJumpHunk
}: Props) {
  const hunkDisabled = diffState.kind !== 'ready' || diffState.hunks.length === 0
  return (
    <View style={styles.fileHeader}>
      <View style={styles.fileTitleRow}>
        <Text
          style={[styles.statusLetter, { color: statusColor(item.status) }]}
          accessibilityLabel={item.status}
        >
          {MOBILE_GIT_STATUS_LABELS[item.status]}
        </Text>
        {/* The bar carries the file name; the full path heads-truncates so the name stays visible. */}
        <View style={styles.fileTitleBlock}>
          <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="head">
            {item.filePath}
          </Text>
          {item.oldPath ? (
            <Text style={styles.fileDirectory} numberOfLines={1} ellipsizeMode="head">
              from {item.oldPath}
            </Text>
          ) : null}
        </View>
        <IconButton
          icon={ChevronUp}
          accessibilityLabel="Previous hunk"
          onPress={() => onJumpHunk('previous')}
          disabled={hunkDisabled}
          variant="bare"
        />
        <IconButton
          icon={ChevronDown}
          accessibilityLabel="Next hunk"
          onPress={() => onJumpHunk('next')}
          disabled={hunkDisabled}
          variant="bare"
        />
      </View>
      <View style={styles.fileMetaRow}>
        <Badge label={mobileReviewScopeLabel(item)} />
        {item.isReviewed ? <Badge label="Reviewed" tone="green" /> : null}
        {item.changedSinceReview ? <Badge label="Changed" tone="amber" /> : null}
        {item.noteCount > 0 ? (
          <Badge label={mobileReviewCountLabel(item.noteCount, 'note', 'notes')} tone="blue" />
        ) : null}
        {item.staleNoteCount > 0 ? (
          <Badge label={`${item.staleNoteCount} stale`} tone="amber" />
        ) : null}
        <Text style={styles.position}>
          {currentIndex + 1} of {filteredCount}
        </Text>
      </View>
      {fileNotes.length > 0 ? (
        <View style={styles.fileNotes}>
          {fileNotes.map((note) => (
            <Pressable
              key={note.id}
              style={({ pressed }) => [styles.fileNote, pressed && styles.fileNotePressed]}
              onPress={() => onEditNote(note)}
              accessibilityRole="button"
              accessibilityLabel="Edit file note"
            >
              <MessageSquare size={15} color={colors.textMuted} strokeWidth={2.2} />
              <Text style={styles.fileNoteText} numberOfLines={2}>
                {note.body}
              </Text>
              {staleCommentIds.has(note.id) ? <Badge label="Stale" tone="amber" /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}
