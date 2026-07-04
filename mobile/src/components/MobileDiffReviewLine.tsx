import { Pressable, StyleSheet, Text, View } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/types'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../session/mobile-file-syntax'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from '../source-control/mobile-diff-format'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'

type Props = {
  line: MobileHighlightedDiffLine<MobileDiffLine>
  comments: readonly DiffComment[]
  staleCommentIds: ReadonlySet<string>
  active: boolean
  onAddNote: (lineNumber: number) => void
  onEditNote: (comment: DiffComment) => void
}

function accessibilityLabelForLine(line: MobileDiffLine): string {
  const number = mobileDiffLineNumber(line)
  const label = line.kind === 'add' ? 'Added' : line.kind === 'delete' ? 'Deleted' : 'Context'
  return number ? `${label} line ${number}` : `${label} line`
}

function canCommentOnLine(line: MobileDiffLine): boolean {
  return line.kind !== 'delete' && line.newLineNumber !== undefined
}

export function MobileDiffReviewLine({
  line,
  comments,
  staleCommentIds,
  active,
  onAddNote,
  onEditNote
}: Props) {
  const lineNumber = mobileDiffLineNumber(line)
  const canComment = canCommentOnLine(line)

  return (
    <View
      style={[
        styles.row,
        line.kind === 'add' && styles.addedRow,
        line.kind === 'delete' && styles.deletedRow,
        active && styles.activeRow
      ]}
      accessible
      accessibilityLabel={accessibilityLabelForLine(line)}
    >
      <Text style={styles.prefix}>{mobileDiffLinePrefix(line.kind)}</Text>
      <Text style={styles.lineNumber}>{lineNumber ? String(lineNumber) : ''}</Text>
      <Pressable
        style={({ pressed }) => [styles.code, pressed && canComment && styles.codePressed]}
        disabled={!canComment}
        onPress={() => {
          if (canComment && line.newLineNumber !== undefined) {
            onAddNote(line.newLineNumber)
          }
        }}
        accessibilityRole={canComment ? 'button' : 'text'}
        accessibilityLabel={
          canComment && line.newLineNumber !== undefined
            ? `Add note on line ${line.newLineNumber}`
            : accessibilityLabelForLine(line)
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
              accessibilityLabel={`Edit note on line ${comment.lineNumber}`}
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
}

// Row height comes from the 18px code lineHeight alone (no vertical padding or
// minHeight) so mobile diff density matches the desktop diff editor (STA-1239).
const styles = StyleSheet.create({
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
  activeRow: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accentBlue
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
})
