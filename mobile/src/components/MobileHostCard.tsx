import { ChevronRight, Monitor } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel } from '../transport/connection-health'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { StatusDot } from './StatusDot'

export function MobileHostCard(props: {
  host: HostProfile
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  worktreeCounts?: { total: number; active: number }
  onPress: () => void
  onLongPress: () => void
}) {
  const connected = props.state === 'connected'
  const isError = ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={400}
    >
      <View style={styles.icon}>
        <Monitor size={20} color={connected ? colors.textPrimary : colors.textSecondary} />
      </View>
      <View style={styles.main}>
        <Text
          style={[styles.name, !connected && { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {props.host.name}
        </Text>
        <View style={styles.meta}>
          <StatusDot state={props.state} verdict={props.verdict} />
          <Text style={[styles.metaText, isError && { color: colors.statusRed }]}>
            {verdictDisplayLabel(props.verdict)}
            {connected ? ` · ${mobileConnectionPathLabel(props.path)}` : ''}
            {connected && props.worktreeCounts
              ? ` · ${props.worktreeCounts.total} worktree${props.worktreeCounts.total !== 1 ? 's' : ''}${props.worktreeCounts.active > 0 ? ` · ${props.worktreeCounts.active} active` : ''}`
              : ''}
          </Text>
        </View>
        {props.verdict.kind === 'unreachable' && !props.host.relay ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            Update desktop Orca and sign in to connect from anywhere
          </Text>
        ) : null}
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  name: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  metaText: { fontSize: 12, color: colors.textSecondary },
  discoveryHint: {
    marginTop: spacing.xs,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  }
})
