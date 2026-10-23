import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileSyntaxSegment } from '../session/mobile-file-syntax'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from '../source-control/mobile-diff-format'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'

export const DIFF_CODE_FONT_SIZE = 13
export const DIFF_CODE_LINE_HEIGHT = 20

type Props = {
  line: MobileDiffLine & { segments: MobileSyntaxSegment[] }
  /** Marks the hunk the reader is stepping through. */
  active?: boolean
  /** Opens a note on the line; the row fills while held so the gesture is visible. */
  onLongPress?: () => void
  accessibilityLabel?: string
  accessibilityHint?: string
  /** Lets the reader select and copy the code; not combined with a long-press. */
  selectable?: boolean
  /** Drawn after the code and outside its touch area, e.g. note markers or an add button. */
  trailing?: ReactNode
}

/** One diff line, shared by the review screen and the committed-diff preview: number, sign, code. */
export function MobileDiffCodeLine({
  line,
  active = false,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  selectable = false,
  trailing
}: Props) {
  const tinted = line.kind === 'add' || line.kind === 'delete'
  const code = (pressed: boolean) => (
    <View style={[styles.code, pressed && styles.pressed]}>
      <View
        style={[
          styles.gutter,
          line.kind === 'add' && styles.addedGutter,
          line.kind === 'delete' && styles.deletedGutter,
          active && styles.activeGutter
        ]}
      >
        <Text style={styles.number} numberOfLines={1}>
          {mobileDiffLineNumber(line)}
        </Text>
      </View>
      <Text
        style={[
          styles.sign,
          line.kind === 'add' && styles.signAdded,
          line.kind === 'delete' && styles.signDeleted
        ]}
      >
        {tinted ? mobileDiffLinePrefix(line.kind) : ' '}
      </Text>
      <Text style={styles.text} selectable={selectable && !onLongPress}>
        {line.text ? <MobileSyntaxSegments segments={line.segments} /> : ' '}
      </Text>
    </View>
  )
  return (
    <View
      style={[
        styles.row,
        line.kind === 'add' && styles.added,
        line.kind === 'delete' && styles.deleted
      ]}
    >
      {onLongPress ? (
        <Pressable
          style={styles.touch}
          onLongPress={onLongPress}
          delayLongPress={350}
          // Why: a finger that lands to stop a scroll should not flash the row.
          unstable_pressDelay={130}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityActions={[{ name: 'longpress', label: accessibilityHint ?? 'Add note' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'longpress') {
              onLongPress()
            }
          }}
        >
          {({ pressed }) => code(pressed)}
        </Pressable>
      ) : (
        <View style={styles.touch} accessible accessibilityLabel={accessibilityLabel}>
          {code(false)}
        </View>
      )}
      {trailing}
    </View>
  )
}

const mono = {
  fontFamily: typography.monoFamily,
  fontSize: DIFF_CODE_FONT_SIZE,
  lineHeight: DIFF_CODE_LINE_HEIGHT
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  added: { backgroundColor: colors.diffAddedBg },
  deleted: { backgroundColor: colors.diffDeletedBg },
  touch: { flex: 1, minWidth: 0 },
  code: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
  pressed: { backgroundColor: colors.fillPressed },
  gutter: {
    width: 44,
    paddingRight: 6,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  addedGutter: { backgroundColor: colors.diffAddedGutter },
  deletedGutter: { backgroundColor: colors.diffDeletedGutter },
  activeGutter: { borderLeftColor: colors.accentBlue },
  number: {
    ...mono,
    fontSize: 12,
    textAlign: 'right',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  sign: { ...mono, width: 16, textAlign: 'center', color: colors.textMuted },
  signAdded: { color: colors.chatDiffAdded },
  signDeleted: { color: colors.chatDiffRemoved },
  text: { ...mono, flex: 1, minWidth: 0, paddingRight: spacing.sm, color: colors.textPrimary }
})
