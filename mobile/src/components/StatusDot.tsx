import { View, StyleSheet } from 'react-native'
import type { ConnectionState } from '../transport/types'
import type { ConnectionVerdict } from '../transport/connection-health'
import { useTheme } from '../theme/theme-context'
import type { ThemeColors } from '../theme/mobile-theme'

function stateColor(state: ConnectionState, colors: ThemeColors): string {
  switch (state) {
    case 'connected':
      return colors.statusGreen
    case 'connecting':
    case 'handshaking':
    case 'reconnecting':
      return colors.statusAmber
    case 'auth-failed':
      return colors.statusRed
    case 'disconnected':
    default:
      return colors.textMuted
  }
}

// Why: when caller passes a verdict, the dot color reflects the verdict's
// severity instead of the raw transport state. This avoids the "amber dot
// next to red 'Can't reach desktop' label" mismatch — the underlying
// transport is still 'reconnecting' (amber) but the user-visible meaning
// has escalated to error (red).
export function StatusDot({
  state,
  verdict
}: {
  state: ConnectionState
  verdict?: ConnectionVerdict
}) {
  const { colors } = useTheme()
  const color =
    verdict?.kind === 'unreachable' || verdict?.kind === 'auth-failed'
      ? colors.statusRed
      : verdict?.kind === 'warning'
        ? colors.statusAmber
        : stateColor(state, colors)
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8
  }
})
