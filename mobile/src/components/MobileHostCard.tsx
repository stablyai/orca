import { Monitor, MoreVertical } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel } from '../transport/connection-health'
import {
  mobileConnectionPathAccessibilityLabel,
  mobileConnectionPathLabel
} from '../transport/mobile-connection-path-label'
import { useHostDisplay } from '../transport/use-host-display'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { StatusDot } from './StatusDot'

function hostCardWorktreeSummaries(info: HostWorktreeInfo | undefined, t: Translate) {
  const now = Date.now()
  const visual = homeHostWorktreeSummary(info, now)
  const accessibility =
    info && info.activeCount > 0 && (!info.catalogUnavailable || info.staleCounts)
      ? t(
          'components.hostCard.worktreeAccessibilitySummary',
          '{{summary}}, {{activeCount}} active',
          {
            summary: homeHostWorktreeSummary({ ...info, activeCount: 0 }, now),
            activeCount: info.activeCount
          }
        )
      : visual
  return { visual, accessibility }
}

export function MobileHostCard(props: {
  host: HostProfile | HostCatalogEntry
  credentialStatus?: HostCatalogEntry['credentialStatus']
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // Card owns fresh/stale/unavailable wording so callers cannot hide retained counts again (STA-3123).
  worktreeInfo?: HostWorktreeInfo
  onPress: () => void
  onLongPress: () => void
  onOpenActions: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
  const isError =
    credentialMissing || ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const statusLabel = credentialMissing
    ? t('components.hostCard.pairingInvalid', 'Pairing invalid')
    : credentialUnavailable
      ? t('components.hostCard.pairingTemporarilyUnavailable', 'Pairing temporarily unavailable')
      : verdictDisplayLabel(props.verdict)
  const statusVerdict: ConnectionVerdict = credentialMissing
    ? { kind: 'auth-failed', label: statusLabel }
    : credentialUnavailable
      ? { kind: 'warning', label: statusLabel }
      : props.verdict
  const worktreeSummary = hostCardWorktreeSummaries(props.worktreeInfo, t)
  const display = useHostDisplay(props.host)
  const descriptorText = display.descriptorLine
  const connectionPathLabel =
    !credentialMissing && !credentialUnavailable && connected
      ? mobileConnectionPathLabel(props.path)
      : null
  const discoveryHint =
    props.verdict.kind === 'unreachable' && !props.host.relay
      ? t(
          'components.hostCard.updateDesktopHint',
          'Update desktop Orca and sign in to connect from anywhere'
        )
      : null
  const credentialHint = credentialMissing
    ? t('components.hostCard.repairHint', 'Tap to re-pair with your desktop')
    : credentialUnavailable
      ? t('components.hostCard.unlockHint', 'Unlock your phone, then tap to retry')
      : null
  // The verdict's own second line (what to check on the desktop); credential copy wins.
  const verdictDetail =
    credentialHint === null && 'detail' in props.verdict ? (props.verdict.detail ?? null) : null
  const accessibilityLabel = [
    t('components.hostCard.openHost', 'Open {{title}}', { title: display.title }),
    descriptorText,
    statusLabel,
    connectionPathLabel ? mobileConnectionPathAccessibilityLabel(props.path) : null,
    connected ? worktreeSummary.accessibility : null,
    discoveryHint,
    credentialHint,
    verdictDetail
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
            {display.title}
          </Text>
          {descriptorText ? (
            <Text style={styles.platformText} numberOfLines={1}>
              {descriptorText}
            </Text>
          ) : null}
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
          {connected && worktreeSummary.visual ? (
            <Text style={styles.worktreeMetaText} numberOfLines={1}>
              {worktreeSummary.visual}
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
          {verdictDetail ? (
            <Text style={styles.discoveryHint} numberOfLines={2}>
              {verdictDetail}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('components.hostCard.hostActions', 'Actions for {{title}}', {
          title: display.title
        })}
        hitSlop={8}
        style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
        onPress={props.onOpenActions}
      >
        <MoreVertical size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
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
  platformText: { color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  worktreeMetaText: {
    marginTop: 2,
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
}))
