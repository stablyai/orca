import { View, Text, StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { FAB_SIZE } from './NewWorkspaceFab'

// Shows what Herm HEARD and what Herm SAID, above the host panel's FAB row.
// Why it exists: voice with no visible transcript is unfalsifiable — when the
// answer is wrong you cannot tell a mis-heard question from a bad answer, so
// every dogfood session turns into guesswork. Errors take the answer's slot
// rather than failing silent.

type HostVoiceTranscriptStripProps = {
  question: string | null
  answer: string | null
  error: string | null
  /** Distance from the screen bottom, so the strip clears the FAB row. */
  bottom: number
}

export function HostVoiceTranscriptStrip({
  question,
  answer,
  error,
  bottom
}: HostVoiceTranscriptStripProps): React.JSX.Element | null {
  if (!question && !error) {
    return null
  }
  return (
    // Why pointerEvents="none": the strip overlays the workspace list, and a
    // stale transcript must never eat a row tap.
    <View style={[styles.strip, { bottom }]} pointerEvents="none">
      {question ? (
        <Text style={styles.question} numberOfLines={2}>
          {question}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} numberOfLines={2}>
          {error}
        </Text>
      ) : answer ? (
        <Text style={styles.answer} numberOfLines={4}>
          {answer}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    // Left inset clears the "+" FAB, right inset clears the mic FAB.
    left: spacing.lg + FAB_SIZE + spacing.md,
    right: spacing.lg + FAB_SIZE + spacing.md,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2
  },
  question: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  answer: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  error: {
    fontSize: typography.metaSize,
    color: colors.statusRed
  }
})
