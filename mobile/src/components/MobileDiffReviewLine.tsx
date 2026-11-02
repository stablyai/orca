import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../session/mobile-file-syntax'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from '../source-control/mobile-diff-format'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'

// Each pickable line row carries this id, so a drag finds the row under the finger in the page itself.
export const DIFF_LINE_ID_PREFIX = 'orca-review-diff-line-'

type Props = {
  line: MobileHighlightedDiffLine<MobileDiffLine>
  comments: readonly DiffComment[]
  staleCommentIds: ReadonlySet<string>
  /** Part of the lines picked for a note. */
  selected?: boolean
  /** Absent where lines take no notes, e.g. a past commit's files. */
  onAddNote?: (lineNumber: number) => void
  onEditNote: (comment: DiffComment) => void
}

function accessibilityLabelForLine(line: MobileDiffLine, t: Translate): string {
  const number = mobileDiffLineNumber(line)
  if (line.kind === 'add') {
    return number
      ? t('components.diffReviewLine.addedLineNumber', 'Added line {{number}}', { number })
      : t('components.diffReviewLine.addedLine', 'Added line')
  }
  if (line.kind === 'delete') {
    return number
      ? t('components.diffReviewLine.deletedLineNumber', 'Deleted line {{number}}', { number })
      : t('components.diffReviewLine.deletedLine', 'Deleted line')
  }
  return number
    ? t('components.diffReviewLine.contextLineNumber', 'Context line {{number}}', { number })
    : t('components.diffReviewLine.contextLine', 'Context line')
}

function canCommentOnLine(line: MobileDiffLine): boolean {
  return line.kind !== 'delete' && line.newLineNumber !== undefined
}

export const MobileDiffReviewLine = memo(function MobileDiffReviewLine({
  line,
  comments,
  staleCommentIds,
  selected = false,
  onAddNote,
  onEditNote
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const lineNumber = mobileDiffLineNumber(line)
  const canComment = onAddNote !== undefined && canCommentOnLine(line)

  return (
    <View
      style={[
        styles.row,
        line.kind === 'add' && styles.addedRow,
        line.kind === 'delete' && styles.deletedRow,
        selected && styles.selectedRow
      ]}
      accessible
      accessibilityLabel={accessibilityLabelForLine(line, t)}
      {...(canComment && line.newLineNumber !== undefined
        ? { nativeID: `${DIFF_LINE_ID_PREFIX}${line.newLineNumber}` }
        : {})}
    >
      <Text style={styles.prefix}>{mobileDiffLinePrefix(line.kind)}</Text>
      <Text style={styles.lineNumber}>{lineNumber ? String(lineNumber) : ''}</Text>
      <Pressable
        style={({ pressed }) => [styles.code, pressed && canComment && styles.codePressed]}
        disabled={!canComment}
        onPress={() => {
          if (canComment && line.newLineNumber !== undefined) {
            onAddNote?.(line.newLineNumber)
          }
        }}
        accessibilityRole={canComment ? 'button' : 'text'}
        accessibilityLabel={
          canComment && line.newLineNumber !== undefined
            ? t('components.diffReviewLine.addNoteOnLine', 'Add note on line {{number}}', {
                number: line.newLineNumber
              })
            : accessibilityLabelForLine(line, t)
        }
      >
        <Text style={styles.codeText}>
          <MobileSyntaxSegments segments={line.segments} />
        </Text>
      </Pressable>
      {comments.length > 0 ? (
        <View style={styles.notes}>
          {comments.map((comment) => (
            <Pressable
              key={comment.id}
              style={({ pressed }) => [styles.noteButton, pressed && styles.noteButtonPressed]}
              onPress={() => onEditNote(comment)}
              accessibilityRole="button"
              accessibilityLabel={t(
                'components.diffReviewLine.editNoteOnLine',
                'Edit note on line {{number}}',
                {
                  number: comment.lineNumber
                }
              )}
            >
              <MessageSquare
                size={13}
                color={staleCommentIds.has(comment.id) ? colors.statusAmber : colors.textSecondary}
                strokeWidth={2}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
})

// Use 18px lineHeight alone without padding/minHeight to match desktop diff density (STA-1239).
const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  addedRow: {
    backgroundColor: colors.diffAddedBg
  },
  deletedRow: {
    backgroundColor: colors.diffDeletedBg
  },
  // The same blue tint the composer gives a picked skill.
  selectedRow: {
    backgroundColor: colors.skillTokenSurface
  },
  prefix: {
    width: 18,
    textAlign: 'center',
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  lineNumber: {
    width: 44,
    paddingRight: spacing.xs,
    textAlign: 'right',
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  code: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: spacing.sm
  },
  codePressed: {
    backgroundColor: colors.bgRaised
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 18
  },
  notes: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  noteButton: {
    minWidth: 32,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noteButtonPressed: {
    opacity: 0.72
  }
}))
