import { ChevronRight, Monitor } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel, verdictSupportingMessage } from '../transport/connection-health'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { StatusDot } from './StatusDot'

export function MobileHostCard(props: {
  host: HostProfile
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // Why: the card owns the fresh/stale/unavailable wording so no caller can re-gate the counts
  // away (STA-3123 shipped that bug once already).
  worktreeInfo?: HostWorktreeInfo
  statusActions?: { label: string; onPress: () => void }[]
  onPress: () => void
  onLongPress: () => void
}) {
  const connected = props.state === 'connected'
  // Why: a relay dial can run for seconds behind "Connecting…"/"Reconnecting…"; naming the
  // path mid-wait tells the user the phone is off-LAN rather than hung (F5). Only 'relay' is
  // named — 'lan' doubles as the unknown-path default, so it would be a guess before connect.
  const dialingPath =
    ['connecting', 'handshaking', 'reconnecting'].includes(props.state) && props.path === 'relay'
  const isError = ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const worktreeSummary = homeHostWorktreeSummary(props.worktreeInfo)
  const supportingMessage = verdictSupportingMessage(props.verdict)
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
          <Text style={[styles.metaText, isError && { color: colors.statusRed }]} numberOfLines={1}>
            {verdictDisplayLabel(props.verdict)}
            {connected || dialingPath ? ` · ${mobileConnectionPathLabel(props.path)}` : ''}
          </Text>
        </View>
        {connected && worktreeSummary ? (
          <Text style={styles.worktreeMetaText} numberOfLines={1}>
            {worktreeSummary}
          </Text>
        ) : null}
        {supportingMessage ? (
          <Text style={styles.supportingMessage} numberOfLines={3}>
            {supportingMessage}
          </Text>
        ) : null}
        {props.verdict.kind === 'unreachable' && !props.host.relay ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            Update desktop Orca and sign in to connect from anywhere
          </Text>
        ) : null}
        {props.statusActions?.length ? (
          <View style={styles.statusActions}>
            {props.statusActions.map((action) => (
              <Pressable
                key={action.label}
                style={styles.statusAction}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={(event) => {
                  event.stopPropagation()
                  action.onPress()
                }}
                hitSlop={8}
              >
                <Text style={styles.statusActionText}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
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
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  worktreeMetaText: {
    marginTop: 2,
    marginLeft: spacing.xl,
    fontSize: 12,
    color: colors.textMuted
  },
  supportingMessage: {
    marginTop: spacing.xs,
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  discoveryHint: {
    marginTop: spacing.xs,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  },
  statusActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap'
  },
  statusAction: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  statusActionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
