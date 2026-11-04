import { ChevronRight } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { StatusDot, statusDotColor } from '../components/StatusDot'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel } from '../transport/connection-health'
import { mobileConnectionPathAccessibilityLabel } from '../transport/mobile-connection-path-label'
import { useHostDisplay } from '../transport/use-host-display'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { homeListStyles as styles } from './home-list-styles'

const PROBLEM_VERDICTS: ReadonlySet<ConnectionVerdict['kind']> = new Set([
  'warning',
  'unreachable',
  'auth-failed'
])

function worktreeSummaries(info: HostWorktreeInfo | undefined, t: Translate) {
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

export function MobileHomeDesktopRow(props: {
  host: HostProfile | HostCatalogEntry
  credentialStatus?: HostCatalogEntry['credentialStatus']
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // The row owns fresh/stale/unavailable wording so callers cannot hide retained counts again (STA-3123).
  worktreeInfo?: HostWorktreeInfo
  onPress: () => void
  onLongPress: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
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
  // The words take the dot's severity, so an amber warning never reads red.
  const statusColor = PROBLEM_VERDICTS.has(statusVerdict.kind)
    ? statusDotColor(props.state, statusVerdict)
    : colors.textSecondary
  const worktreeSummary = worktreeSummaries(props.worktreeInfo, t)
  const display = useHostDisplay(props.host)
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
  const details = [discoveryHint, credentialHint, verdictDetail].filter((line): line is string =>
    Boolean(line)
  )
  const subtitle = connected && worktreeSummary.visual ? worktreeSummary.visual : statusLabel
  const accessibilityLabel = [
    t('components.hostCard.openHost', 'Open {{title}}', { title: display.title }),
    display.descriptorLine,
    statusLabel,
    connected ? mobileConnectionPathAccessibilityLabel(props.path) : null,
    connected ? worktreeSummary.accessibility : null,
    ...details
  ]
    .filter(Boolean)
    .join(', ')
  const optionsLabel = t('components.hostCard.hostActions', 'Actions for {{title}}', {
    title: display.title
  })

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityActions={[{ name: 'longpress', label: optionsLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') {
          props.onLongPress()
        }
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={400}
    >
      <View style={styles.status}>
        <View style={styles.statusDotBox}>
          <StatusDot state={props.state} verdict={statusVerdict} />
        </View>
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {display.title}
        </Text>
        <Text style={[styles.subtitle, { color: statusColor }]} numberOfLines={connected ? 1 : 2}>
          {subtitle}
        </Text>
        {details.map((line) => (
          <Text key={line} style={styles.detail} numberOfLines={3}>
            {line}
          </Text>
        ))}
      </View>
      <View style={styles.trailing}>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
