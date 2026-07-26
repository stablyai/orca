import { ChevronRight, Monitor } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { useMobileLocale } from '../localization/mobile-locale-provider'
import type { TranslationKey } from '../localization/mobile-locale'
import { StatusDot } from './StatusDot'

function connectionStatusKey(state: ConnectionState, verdict: ConnectionVerdict): TranslationKey {
  if (verdict.kind === 'auth-failed') {
    return 'host.pairingInvalid'
  }
  if (verdict.kind === 'unreachable') {
    return 'host.cantReachDesktop'
  }
  if (verdict.kind === 'warning') {
    return 'host.cantConnect'
  }
  if (state === 'connected') {
    return 'host.connected'
  }
  if (state === 'disconnected') {
    return 'host.disconnected'
  }
  return state === 'reconnecting' ? 'host.reconnecting' : 'host.connecting'
}

export function MobileHostCard(props: {
  host: HostProfile
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  worktreeCounts?: { total: number; active: number }
  onPress: () => void
  onLongPress: () => void
}) {
  const { t } = useMobileLocale()
  const connected = props.state === 'connected'
  const isError = ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const statusLabel = t(connectionStatusKey(props.state, props.verdict))
  const displayStatus =
    (props.verdict.kind === 'warning' || props.verdict.kind === 'unreachable') && props.verdict.hint
      ? t('host.statusWithHint', {
          status: statusLabel,
          hint:
            props.verdict.hint === 'check Tailscale' ? t('host.checkTailscale') : props.verdict.hint
        })
      : statusLabel
  const connectionPath =
    props.path === 'relay'
      ? t('host.pathRelay')
      : props.path === 'tailscale'
        ? t('host.pathTailscale')
        : t('host.pathLan')
  const worktreeSummary = props.worktreeCounts
    ? `${t(props.worktreeCounts.total === 1 ? 'host.worktreeOne' : 'host.worktreeMany', {
        count: props.worktreeCounts.total
      })}${
        props.worktreeCounts.active > 0
          ? t('host.activeWorktrees', { count: props.worktreeCounts.active })
          : ''
      }`
    : null
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
            {displayStatus}
            {connected ? ` · ${connectionPath}` : ''}
          </Text>
        </View>
        {connected && worktreeSummary ? (
          <Text style={styles.worktreeMetaText} numberOfLines={1}>
            {worktreeSummary}
          </Text>
        ) : null}
        {props.verdict.kind === 'unreachable' && !props.host.relay ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            {t('host.discoveryHint')}
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
