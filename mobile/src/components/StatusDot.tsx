import { View, StyleSheet } from 'react-native'
import type { ThemeColors } from '../theme/mobile-theme'
import { useTheme } from '../theme/theme-context'
import type { ConnectionState } from '../transport/types'
import type { ConnectionVerdict } from '../transport/connection-health'

function resolveStateColor(
  state: ConnectionState,
  colors: ThemeColors,
  verdict?: ConnectionVerdict
): string {
  if (verdict?.kind === 'unreachable' || verdict?.kind === 'auth-failed') {
    return colors.statusRed
  }
  if (verdict?.kind === 'warning') {
    return colors.statusAmber
  }
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
  const color = resolveStateColor(state, colors, verdict)
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

// Layout-only sheet — no palette tokens, so it stays module-scope.
const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8
  }
})
