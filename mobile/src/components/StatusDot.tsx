import { View, StyleSheet } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { ConnectionState } from '../transport/types'

const stateColors: Record<ConnectionState, string> = {
  connected: colors.statusGreen,
  connecting: colors.statusAmber,
  handshaking: colors.statusAmber,
  reconnecting: colors.statusAmber,
  disconnected: colors.textMuted,
  'auth-failed': colors.statusRed
}

export function StatusDot({ state }: { state: ConnectionState }) {
  return <View style={[styles.dot, { backgroundColor: stateColors[state] ?? colors.textMuted }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8
  }
})
