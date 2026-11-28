import { View, StyleSheet } from 'react-native'
import { radii, type MobilePalette } from '../../theme/mobile-theme'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { ConnectionState } from '../../transport/connection/connection-state'
import {
  isConnectionDialing,
  type ConnectionVerdict
} from '../../transport/connection/connection-health'

const stateColors = (colors: MobilePalette): Record<ConnectionState, string> => ({
  connected: colors.statusGreen,
  connecting: colors.statusAmber,
  handshaking: colors.statusAmber,
  reconnecting: colors.statusAmber,
  disconnected: colors.textMuted,
  'auth-failed': colors.statusRed
})

export function statusDotColor(
  colors: MobilePalette,
  state: ConnectionState,
  verdict?: ConnectionVerdict
): string {
  if (verdict?.kind === 'unreachable' || verdict?.kind === 'auth-failed') {
    return colors.statusRed
  }
  if (verdict?.kind === 'warning' || (verdict && isConnectionDialing(verdict))) {
    return colors.statusAmber
  }
  return stateColors(colors)[state] ?? colors.textMuted
}

// Prefer verdict severity over transport color: reconnecting can already mean user-visible error, so dot must match label.
export function StatusDot({
  state,
  verdict
}: {
  state: ConnectionState
  verdict?: ConnectionVerdict
}) {
  const colors = useMobileColors()
  const color = statusDotColor(colors, state, verdict)
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  }
})
