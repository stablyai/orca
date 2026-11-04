import { Pressable, Text, View } from 'react-native'
import { ArrowDown, ArrowUp } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import type { ReviewDiffState } from '../session/mobile-diff-review-screen-model'
import { mobileDiffReviewStyles as styles } from './mobile-diff-review-screen-styles'

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

function fileScopeLabel(t: Translate, item: MobileDiffReviewQueueItem): string {
  if (item.oldPath) {
    const options = { oldPath: item.oldPath }
    return item.scope === 'branch'
      ? t('components.diffReviewFileSummary.branchFrom', 'Branch from {{oldPath}}', options)
      : item.scope === 'staged'
        ? t('components.diffReviewFileSummary.stagedFrom', 'Staged from {{oldPath}}', options)
        : t('components.diffReviewFileSummary.unstagedFrom', 'Unstaged from {{oldPath}}', options)
  }
  return item.scope === 'branch'
    ? t('components.diffReviewFileSummary.branch', 'Branch')
    : item.scope === 'staged'
      ? t('components.diffReviewFileSummary.staged', 'Staged')
      : t('components.diffReviewFileSummary.unstaged', 'Unstaged')
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const count = item.noteCount
  const hunkDisabled = diffState.kind !== 'ready' || diffState.hunks.length === 0
  const badgeColor = statusColor(item.status)
  return (
    <View style={styles.fileHeader}>
      <View style={styles.fileTitleRow}>
        <View style={[styles.statusBadge, { borderColor: badgeColor }]}>
          <Text style={[styles.statusBadgeText, { color: badgeColor }]}>
            {STATUS_LABELS[item.status]}
          </Text>
        </View>
        <View style={styles.fileTitleBlock}>
          <Text style={styles.filePath} numberOfLines={1}>
            {item.filePath}
          </Text>
          <Text style={styles.fileMeta} numberOfLines={1}>
            {fileScopeLabel(t, item)}
          </Text>
        </View>
      </View>
      <View style={styles.fileMetaRow}>
        <Text style={styles.fileMeta}>
          {currentIndex + 1}/{filteredCount}
        </Text>
        {item.isReviewed ? (
          <Text style={styles.reviewedPill}>
            {t('components.diffReviewFileSummary.reviewed', 'Reviewed')}
          </Text>
        ) : null}
        {item.changedSinceReview ? (
          <Text style={styles.stalePill}>
            {t('components.diffReviewFileSummary.changed', 'Changed')}
          </Text>
        ) : null}
        {item.noteCount > 0 ? (
          <Text style={styles.fileMeta}>
            {count === 1
              ? t('components.diffReviewFileSummary.notes_one', '{{count}} note', { count })
              : t('components.diffReviewFileSummary.notes_other', '{{count}} notes', { count })}
          </Text>
        ) : null}
        {item.staleNoteCount > 0 ? (
          <Text style={styles.staleText}>
            {t('components.diffReviewFileSummary.staleCount', '{{count}} stale', {
              count: item.staleNoteCount
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
              accessibilityLabel={t(
                'components.diffReviewFileSummary.editFileNote',
                'Edit file note'
              )}
            >
              <Text style={styles.fileNoteText} numberOfLines={2}>
                {note.body}
              </Text>
              {staleCommentIds.has(note.id) ? (
                <Text style={styles.staleText}>
                  {t('components.diffReviewFileSummary.stale', 'Stale')}
                </Text>
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
          accessibilityLabel={t('components.diffReviewFileSummary.previousHunk', 'Previous hunk')}
        >
          <ArrowUp size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.hunkButtonText}>
            {t('components.diffReviewFileSummary.hunk', 'Hunk')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.hunkButton, pressed && styles.hunkButtonPressed]}
          disabled={hunkDisabled}
          onPress={() => onJumpHunk('next')}
          accessibilityRole="button"
          accessibilityLabel={t('components.diffReviewFileSummary.nextHunk', 'Next hunk')}
        >
          <ArrowDown size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.hunkButtonText}>
            {t('components.diffReviewFileSummary.hunk', 'Hunk')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
