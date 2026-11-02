import { Text, View } from 'react-native'
import type { DiffHunkLine } from '../../../../src/shared/github/pr-comment-diff-hunk'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// The lines a thread is about, as GitHub anchored them, tinted like the diff they came from.
export function PrThreadCode({ lines }: { lines: DiffHunkLine[] }) {
  useMobileColorScheme()
  if (lines.length === 0) {
    return null
  }
  return (
    <View style={styles.code}>
      {lines.map((line) => (
        <Text
          key={line.index}
          style={[
            styles.line,
            line.sign === '+' && styles.added,
            line.sign === '-' && styles.removed
          ]}
          numberOfLines={1}
        >
          <Text style={styles.muted}>{line.number ?? ' '} </Text>
          <Text style={styles.muted}>{line.sign}</Text> {line.text}
        </Text>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  code: { borderRadius: radii.mark, overflow: 'hidden' },
  line: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 20,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  added: { backgroundColor: colors.diffAddedBg },
  removed: { backgroundColor: colors.diffDeletedBg },
  muted: { color: colors.textMuted }
}))
