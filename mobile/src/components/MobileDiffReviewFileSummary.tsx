import { Pressable, Text, View } from 'react-native'
import { ArrowDown, ArrowUp } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/types'
import { colors } from '../theme/mobile-theme'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { MOBILE_GIT_STATUS_LABELS } from '../source-control/mobile-git-status'
import {
  mobileReviewNoteCountLabel,
  mobileReviewScopeLabel,
  type ReviewDiffState
} from '../session/mobile-diff-review-screen-model'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'
import { t } from '@/i18n/mobile-i18n'

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

function statusColor(status: MobileDiffReviewQueueItem['status']): string {
  switch (status) {
    case 'added':
    case 'copied':
      return colors.statusGreen
    case 'deleted':
      return colors.statusRed
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
  const badgeColor = statusColor(item.status)
  return (
    <View style={styles.fileHeader}>
      <View style={styles.fileTitleRow}>
        <View style={[styles.statusBadge, { borderColor: badgeColor }]}>
          <Text style={[styles.statusBadgeText, { color: badgeColor }]}>
            {MOBILE_GIT_STATUS_LABELS[item.status]}
          </Text>
        </View>
        <View style={styles.fileTitleBlock}>
          <Text style={styles.filePath} numberOfLines={1}>
            {item.filePath}
          </Text>
          <Text style={styles.fileMeta} numberOfLines={1}>
            {mobileReviewScopeLabel(item)}
            {item.oldPath
              ? t('mobileDiffReviewFileSummary.old', {
                  oldPath: item.oldPath
                })
              : ''}
          </Text>
        </View>
      </View>
      <View style={styles.fileMetaRow}>
        <Text style={styles.fileMeta}>
          {currentIndex + 1}/{filteredCount}
        </Text>
        {item.isReviewed ? (
          <Text style={styles.reviewedPill}>{t('mobileDiffReviewFileSummary.reviewed')}</Text>
        ) : null}
        {item.changedSinceReview ? (
          <Text style={styles.stalePill}>{t('mobileDiffReviewFileSummary.changed')}</Text>
        ) : null}
        {item.noteCount > 0 ? (
          <Text style={styles.fileMeta}>{mobileReviewNoteCountLabel(item.noteCount)}</Text>
        ) : null}
        {item.staleNoteCount > 0 ? (
          <Text style={styles.staleText}>
            {t('mobileDiffReviewFileSummary.staleNote', {
              staleNoteCount: item.staleNoteCount
            })}
          </Text>
        ) : null}
      </View>
      {fileNotes.length > 0 ? (
        <View style={styles.fileNotes}>
          {fileNotes.map((note) => (
            <Pressable
              key={note.id}
              style={({ pressed }) => [styles.fileNote, pressed && styles.fileNotePressed]}
              onPress={() => onEditNote(note)}
              accessibilityRole="button"
              accessibilityLabel={t('mobileDiffReviewFileSummary.edit')}
            >
              <Text style={styles.fileNoteText} numberOfLines={2}>
                {note.body}
              </Text>
              {staleCommentIds.has(note.id) ? (
                <Text style={styles.staleText}>{t('mobileDiffReviewFileSummary.stale')}</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.hunkRow}>
        <Pressable
          style={({ pressed }) => [styles.hunkButton, pressed && styles.hunkButtonPressed]}
          disabled={hunkDisabled}
          onPress={() => onJumpHunk('previous')}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFileSummary.previous')}
        >
          <ArrowUp size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.hunkButtonText}>{t('mobileDiffReviewFileSummary.hunk')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.hunkButton, pressed && styles.hunkButtonPressed]}
          disabled={hunkDisabled}
          onPress={() => onJumpHunk('next')}
          accessibilityRole="button"
          accessibilityLabel={t('mobileDiffReviewFileSummary.next')}
        >
          <ArrowDown size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.hunkButtonText}>{t('mobileDiffReviewFileSummary.hunk')}</Text>
        </Pressable>
      </View>
    </View>
  )
}
