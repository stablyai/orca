import { Pressable, StyleSheet, View } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../session/mobile-file-syntax'
import { mobileDiffLineNumber } from '../source-control/mobile-diff-format'
import { triggerMediumImpact } from '../platform/haptics'
import { colors, MIN_TOUCH_TARGET, radii } from '../theme/mobile-theme'
import { MobileDiffCodeLine } from './MobileDiffCodeLine'
import { pressTransition } from './ui/transition-styles'

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
  const noteLine = canCommentOnLine(line) ? line.newLineNumber : undefined
  return (
    <MobileDiffCodeLine
      line={line}
      active={active}
      accessibilityLabel={accessibilityLabelForLine(line)}
      accessibilityHint={noteLine !== undefined ? `Add note on line ${noteLine}` : undefined}
      onLongPress={
        noteLine !== undefined
          ? () => {
              triggerMediumImpact()
              onAddNote(noteLine)
            }
          : undefined
      }
      trailing={
        comments.length > 0 ? (
          <View style={styles.notes}>
            {comments.map((comment) => {
              const stale = staleCommentIds.has(comment.id)
              return (
                <Pressable
                  key={comment.id}
                  style={styles.noteTouch}
                  onPress={() => onEditNote(comment)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit note on line ${comment.lineNumber}`}
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.noteMarker,
                        stale && styles.noteMarkerStale,
                        pressed && styles.noteMarkerPressed,
                        pressed ? pressTransition.pressed : pressTransition.rest
                      ]}
                    >
                      <MessageSquare
                        size={14}
                        color={stale ? colors.statusAmber : colors.textPrimary}
                        strokeWidth={2.2}
                      />
                    </View>
                  )}
                </Pressable>
              )
            })}
          </View>
        ) : null
      }
    />
  )
}

const styles = StyleSheet.create({
  notes: { width: MIN_TOUCH_TARGET, alignItems: 'center' },
  noteTouch: {
    width: MIN_TOUCH_TARGET,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noteMarker: {
    width: 32,
    height: 24,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fillPressed
  },
  noteMarkerStale: { backgroundColor: 'rgba(245, 158, 11, 0.16)' },
  noteMarkerPressed: { transform: [{ scale: 0.92 }], backgroundColor: colors.fieldBorderFocused }
})
