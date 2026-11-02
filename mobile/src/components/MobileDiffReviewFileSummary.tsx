import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import { colors, pressedStyle, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { mobileDiffReviewStyles } from './mobile-diff-review-screen-styles'

type Props = {
  fileNotes: DiffComment[]
  item: MobileDiffReviewQueueItem
  staleCommentIds: ReadonlySet<string>
  onEditNote: (comment: DiffComment) => void
  onToggleViewed: (item: MobileDiffReviewQueueItem) => void
  /** GitHub threads on this file that can't sit under their lines until the branch matches the PR. */
  hiddenThreadCount: number
}

/** Uncommitted files are staged rather than viewed, and a past commit's files are read-only. */
export function canMarkMobileDiffReviewItemViewed(item: MobileDiffReviewQueueItem): boolean {
  return item.scope === 'staged' || item.scope === 'branch'
}

function areaPillLabel(t: Translate, item: MobileDiffReviewQueueItem): string | null {
  if (item.area === 'untracked') {
    return t('components.diffReviewFileSummary.untracked', 'Untracked')
  }
  return item.scope === 'unstaged'
    ? t('components.diffReviewFileSummary.notStaged', 'Not staged')
    : null
}

export function MobileDiffReviewFileSummary({
  fileNotes,
  item,
  staleCommentIds,
  onEditNote,
  onToggleViewed,
  hiddenThreadCount
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const pill = areaPillLabel(t, item)
  return (
    <View style={styles.header}>
      <View style={styles.row}>
        <Text style={styles.path} numberOfLines={1}>
          {item.filePath}
        </Text>
        <MobileDiffLineStats added={item.added} removed={item.removed} />
        {item.changedSinceReview ? (
          <Text style={styles.changedPill}>
            {t('components.diffReviewFileSummary.changed', 'Changed')}
          </Text>
        ) : null}
        {pill ? <Text style={styles.pill}>{pill}</Text> : null}
        {canMarkMobileDiffReviewItemViewed(item) ? (
          <ViewedCheckbox
            viewed={item.isReviewed}
            onPress={() => onToggleViewed(item)}
            accessibilityLabel={t('components.diffReviewFileSummary.viewed', 'Viewed')}
          />
        ) : null}
      </View>
      {hiddenThreadCount > 0 ? (
        <Text style={styles.meta} numberOfLines={2}>
          {hiddenThreadCount === 1
            ? t(
                'components.diffReviewFileSummary.threadsWhenInSync_one',
                'Its GitHub comment shows here once this branch matches the pull request.',
                { count: hiddenThreadCount }
              )
            : t(
                'components.diffReviewFileSummary.threadsWhenInSync_other',
                'Its {{count}} GitHub comments show here once this branch matches the pull request.',
                { count: hiddenThreadCount }
              )}
        </Text>
      ) : null}
      {item.oldPath ? (
        <Text style={styles.meta} numberOfLines={1}>
          {t('components.diffReviewFileSummary.renamedFrom', 'Renamed from {{oldPath}}', {
            oldPath: item.oldPath
          })}
        </Text>
      ) : null}
      {fileNotes.length > 0 ? (
        <View style={mobileDiffReviewStyles.fileNotes}>
          {fileNotes.map((note) => (
            <Pressable
              key={note.id}
              style={({ pressed }) => [
                mobileDiffReviewStyles.fileNote,
                pressed && mobileDiffReviewStyles.fileNotePressed
              ]}
              onPress={() => onEditNote(note)}
              accessibilityRole="button"
              accessibilityLabel={t(
                'components.diffReviewFileSummary.editFileNote',
                'Edit file note'
              )}
            >
              <Text style={mobileDiffReviewStyles.fileNoteText} numberOfLines={2}>
                {note.body}
              </Text>
              {staleCommentIds.has(note.id) ? (
                <Text style={mobileDiffReviewStyles.staleText}>
                  {t('components.diffReviewFileSummary.stale', 'Stale')}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

export function MobileDiffLineStats({ added, removed }: { added?: number; removed?: number }) {
  useMobileColorScheme()
  return (
    <>
      {added ? <Text style={styles.added}>+{added}</Text> : null}
      {removed ? <Text style={styles.removed}>−{removed}</Text> : null}
    </>
  )
}

export function ViewedCheckbox({
  viewed,
  onPress,
  accessibilityLabel
}: {
  viewed: boolean
  onPress: () => void
  accessibilityLabel: string
}) {
  useMobileColorScheme()
  return (
    <Pressable
      onPress={onPress}
      hitSlop={spacing.md}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: viewed }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.box, viewed && styles.boxChecked, pressed && pressedStyle]}
    >
      {viewed ? <Check size={14} color={colors.onAccent} strokeWidth={3} /> : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  path: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  meta: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  added: {
    color: colors.statusGreen,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  removed: {
    color: colors.statusRed,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  pill: {
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    color: colors.statusAmber,
    backgroundColor: colors.translucentFill,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  changedPill: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: radii.mark,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  boxChecked: {
    backgroundColor: colors.accentBlue,
    borderColor: colors.accentBlue
  }
}))
