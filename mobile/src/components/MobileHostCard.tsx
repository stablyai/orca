import { ChevronRight, Monitor } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel } from '../transport/connection-health'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { StatusDot } from './StatusDot'

export function MobileHostCard(props: {
  host: HostProfile | HostCatalogEntry
  credentialStatus?: HostCatalogEntry['credentialStatus']
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // Why: the card owns the fresh/stale/unavailable wording so no caller can re-gate the counts
  // away (STA-3123 shipped that bug once already).
  worktreeInfo?: HostWorktreeInfo
  onPress: () => void
  onLongPress: () => void
}) {
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
  // Why: a relay dial can run for seconds behind "Connecting…"/"Reconnecting…"; naming the
  // path mid-wait tells the user the phone is off-LAN rather than hung (F5). Only 'relay' is
  // named — 'lan' doubles as the unknown-path default, so it would be a guess before connect.
  const dialingPath =
    ['connecting', 'handshaking', 'reconnecting'].includes(props.state) && props.path === 'relay'
  const isError =
    credentialMissing || ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const statusLabel = credentialMissing
    ? 'Pairing invalid'
    : credentialUnavailable
      ? 'Pairing temporarily unavailable'
      : verdictDisplayLabel(props.verdict)
  const statusVerdict: ConnectionVerdict = credentialMissing
    ? { kind: 'auth-failed', label: statusLabel }
    : credentialUnavailable
      ? { kind: 'warning', label: statusLabel }
      : props.verdict
  const worktreeSummary = homeHostWorktreeSummary(props.worktreeInfo)
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
          <StatusDot state={props.state} verdict={statusVerdict} />
          <Text
            style={[
              styles.metaText,
              isError && { color: colors.statusRed },
              credentialUnavailable && { color: colors.statusAmber }
            ]}
            numberOfLines={1}
          >
            {statusLabel}
            {!credentialMissing && !credentialUnavailable && (connected || dialingPath)
              ? ` · ${mobileConnectionPathLabel(props.path)}`
              : ''}
          </Text>
        </View>
        {connected && worktreeSummary ? (
          <Text style={styles.worktreeMetaText} numberOfLines={1}>
            {worktreeSummary}
          </Text>
        ) : null}
        {props.verdict.kind === 'unreachable' && !props.host.relay ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            Update desktop Orca and sign in to connect from anywhere
          </Text>
        ) : null}
        {credentialMissing || credentialUnavailable ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            {credentialMissing
              ? 'Tap to re-pair with your desktop'
              : 'Unlock your phone, then tap to retry'}
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
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  worktreeMetaText: {
    marginTop: 2,
    marginLeft: spacing.xl,
    fontSize: 12,
    color: colors.textMuted
  },
  discoveryHint: {
    marginTop: spacing.xs,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  }
})
