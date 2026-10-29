import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Pause, Play, Square } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useReaderControls } from './reader-controls'
import { pauseReading, playReading, stopSpeaking, useReaderState } from './reply-speaker'
import { useAutoReadReplies } from './use-auto-read-replies'

// Why: mounted once above the navigator, so the pills also cover desktop-served pages the shell
// cannot add controls to.
export function ReplyReaderOverlay(): React.JSX.Element | null {
  useMobileColorScheme()
  useAutoReadReplies()
  useReaderControls()
  const state = useReaderState()
  const insets = useSafeAreaInsets()
  if (state === 'idle') {
    return null
  }
  const paused = state === 'paused'
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + spacing.xs }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={paused ? 'Resume reading' : 'Pause reading'}
        hitSlop={8}
        style={styles.pill}
        onPress={() => (paused ? playReading('Resume pill') : pauseReading('Pause pill'))}
      >
        {paused ? (
          <Play size={12} color={colors.textPrimary} />
        ) : (
          <Pause size={12} color={colors.textPrimary} />
        )}
        <Text style={styles.label}>{paused ? 'Resume' : 'Pause'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop reading reply"
        hitSlop={8}
        style={styles.pill}
        onPress={() => stopSpeaking('Stop button')}
      >
        <Square size={12} color={colors.textPrimary} />
        <Text style={styles.label}>Stop</Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  label: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  }
}))
