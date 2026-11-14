import { memo } from 'react'
import { Platform, Pressable, Text, View, type ViewStyle } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { DiffComment } from '../../../../../src/shared/diff-comment-types'
import type { MobileDiffLine } from '../diff-state/mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../../../files/session-documents/mobile-file-syntax'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from '../diff-state/mobile-diff-format'
import { colors, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileSyntaxSegments } from '../../../components/MobileSyntaxSegments'

// Each pickable line row carries this id, so a drag finds the row under the finger in the page itself.
export const DIFF_LINE_ID_PREFIX = 'orca-review-diff-line-'

type Props = {
  line: MobileHighlightedDiffLine<MobileDiffLine>
  comments: readonly DiffComment[]
  staleCommentIds: ReadonlySet<string>
  /** Part of the lines picked for a note. */
  selected?: boolean
  /** Fits the file's longest line number, so every row's gutter lines up. */
  numberWidth: number
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
  numberWidth,
  onAddNote,
  onEditNote
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const lineNumber = mobileDiffLineNumber(line)
  const canComment = onAddNote !== undefined && canCommentOnLine(line)
  const ground = [
    line.kind === 'add' && styles.addedRow,
    line.kind === 'delete' && styles.deletedRow,
    selected && styles.selectedRow
  ]

  return (
    <View
      style={[styles.row, ...ground]}
      accessible
      accessibilityLabel={accessibilityLabelForLine(line, t)}
      {...(canComment && line.newLineNumber !== undefined
        ? { nativeID: `${DIFF_LINE_ID_PREFIX}${line.newLineNumber}` }
        : {})}
    >
      {/* Pinned while the file scrolls sideways, so it repaints the row's tint over an opaque ground. */}
      <View style={[styles.pinned, styles.pinnedLeft]}>
        <View style={[styles.gutter, ...ground]}>
          <Text
            style={[
              styles.lineNumber,
              { width: numberWidth },
              line.kind === 'add' && styles.addedNumber,
              line.kind === 'delete' && styles.deletedNumber
            ]}
          >
            {lineNumber ? String(lineNumber) : ''}
          </Text>
          <Text
            style={[
              styles.sign,
              line.kind === 'add' && styles.addedSign,
              line.kind === 'delete' && styles.deletedSign
            ]}
          >
            {mobileDiffLinePrefix(line.kind)}
          </Text>
        </View>
      </View>
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
        <View style={[styles.pinned, styles.pinnedRight]}>
          <View style={[styles.notes, ...ground]}>
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
                  color={
                    staleCommentIds.has(comment.id) ? colors.statusAmber : colors.textSecondary
                  }
                  strokeWidth={2}
                />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
})

/** Renders one code line's worth of a known string, so the list can size its columns to the code font. */
export function MobileDiffReviewCharWidthProbe({
  onCharWidth
}: {
  onCharWidth: (width: number) => void
}) {
  return (
    <Text
      aria-hidden
      style={[styles.codeText, styles.probe]}
      onLayout={(event) => onCharWidth(event.nativeEvent.layout.width / PROBE_TEXT.length)}
    >
      {PROBE_TEXT}
    </Text>
  )
}

const PROBE_TEXT = '0'.repeat(100)
const SIGN_WIDTH = 14
// Room either side of the line number.
const NUMBER_PADDING = 12

export function mobileDiffReviewGutterWidth(numberWidth: number): number {
  return numberWidth + SIGN_WIDTH
}

export function mobileDiffReviewNumberWidth(digits: number, charWidth: number): number {
  return Math.ceil(digits * charWidth + NUMBER_PADDING)
}

// The page lets long lines run and the file scroll sideways under pinned cells (Kelvin's choice over wrapping).
const webPinned: ViewStyle =
  Platform.OS === 'web'
    ? {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RN Web renders CSS sticky; this branch never reaches native.
        position: 'sticky' as ViewStyle['position'],
        zIndex: 1
      }
    : {}

// Use 18px lineHeight alone without padding/minHeight to match desktop diff density (STA-1239).
const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch'
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
  pinned: {
    ...webPinned,
    backgroundColor: colors.bgBase
  },
  pinnedLeft: {
    left: 0
  },
  pinnedRight: {
    right: 0
  },
  gutter: {
    flex: 1,
    flexDirection: 'row'
  },
  lineNumber: {
    paddingRight: 6,
    textAlign: 'right',
    color: colors.diffLineNumber,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  addedNumber: {
    color: colors.textPrimary,
    backgroundColor: colors.diffAddedGutter
  },
  deletedNumber: {
    color: colors.textPrimary,
    backgroundColor: colors.diffDeletedGutter
  },
  sign: {
    width: SIGN_WIDTH,
    textAlign: 'center',
    color: colors.diffLineNumber,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  addedSign: {
    color: colors.diffAddedSign
  },
  deletedSign: {
    color: colors.diffDeletedSign
  },
  code: {
    flex: 1,
    minWidth: 0,
    paddingRight: 10
  },
  codePressed: {
    backgroundColor: colors.bgRaised
  },
  codeText: {
    ...(Platform.OS === 'web' ? { whiteSpace: 'pre' as const } : {}),
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 18
  },
  probe: {
    position: 'absolute',
    opacity: 0
  },
  notes: {
    flex: 1,
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
