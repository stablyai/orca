import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'
import type { TerminalStreamInputFailure } from '../transport/terminal-stream-input-failure'

export function MobileTerminalInputRecovery({
  failure,
  onRecover,
  recoveryUnavailable
}: {
  failure: TerminalStreamInputFailure
  onRecover: () => void
  recoveryUnavailable: boolean
}) {
  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <Text style={styles.title}>Terminal input paused</Text>
      <Text style={styles.detail}>
        {failure.outcome === 'unknown'
          ? 'Some input may have reached the terminal. Check its contents before continuing.'
          : 'The host did not accept the input. Check the terminal before continuing.'}{' '}
        Input will not be replayed.
      </Text>
      {recoveryUnavailable && (
        <Text style={styles.detail}>
          Recovery needs a new connection to a host that supports ordered input. Update the host if
          needed.
        </Text>
      )}
      <Pressable accessibilityRole="button" onPress={onRecover} style={styles.button}>
        <Text style={styles.title}>Reconnect input</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8, backgroundColor: colors.terminalBg },
  title: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' },
  detail: { color: colors.textSecondary, fontSize: typography.metaSize },
  button: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' }
})
