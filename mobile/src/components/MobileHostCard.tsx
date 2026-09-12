import { Monitor, MoreVertical } from 'lucide-react-native'
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
  onOpenActions: () => void
}) {
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
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
  const connectionPathLabel =
    !credentialMissing && !credentialUnavailable && connected
      ? mobileConnectionPathLabel(props.path)
      : null
  const discoveryHint =
    props.verdict.kind === 'unreachable' && !props.host.relay
      ? 'Update desktop Orca and sign in to connect from anywhere'
      : null
  const credentialHint = credentialMissing
    ? 'Tap to re-pair with your desktop'
    : credentialUnavailable
      ? 'Unlock your phone, then tap to retry'
      : null
  const accessibilityLabel = [
    `Open ${props.host.name}`,
    statusLabel,
    connectionPathLabel?.replace(' · ', ' via '),
    connected ? worktreeSummary?.replace(' · ', ', ') : null,
    discoveryHint,
    credentialHint
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
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
              {connectionPathLabel ? ` · ${connectionPathLabel}` : ''}
            </Text>
          </View>
          {connected && worktreeSummary ? (
            <Text style={styles.worktreeMetaText} numberOfLines={1}>
              {worktreeSummary}
            </Text>
          ) : null}
          {discoveryHint ? (
            <Text style={styles.discoveryHint} numberOfLines={2}>
              {discoveryHint}
            </Text>
          ) : null}
          {credentialHint ? (
            <Text style={styles.discoveryHint} numberOfLines={2}>
              {credentialHint}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${props.host.name}`}
        hitSlop={8}
        style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
        onPress={props.onOpenActions}
      >
        <MoreVertical size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingVertical: 12
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
  },
  actionButton: {
    width: 40,
    height: 40,
    marginHorizontal: spacing.xs,
    borderRadius: radii.row,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionButtonPressed: {
    backgroundColor: colors.bgRaised
  }
})
