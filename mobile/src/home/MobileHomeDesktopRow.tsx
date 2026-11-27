import { ChevronRight, Laptop, Monitor, Server, type LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { statusDotColor } from '../components/feedback/StatusDot'
import type { ConnectionVerdict } from '../transport/connection/connection-health'
import { verdictDisplayLabel } from '../transport/connection/connection-health'
import { mobileConnectionPathAccessibilityLabel } from '../transport/connection/mobile-connection-path-label'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import type { MobileConnectionPath } from '../transport/connection/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HostCatalogEntry, HostProfile } from '../host-catalog/host-profile'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import {
  homeHostWorktreeSummary,
  type HostWorktreeInfo
} from '../worktree/catalog/home-worktree-info'
import { homeListStylesSheet as stylesSheet } from './home-list-styles'
import { useThemedStyles } from '../theme/themed-styles'

const MACHINE_GLYPHS: Record<'laptop' | 'desktop' | 'server', LucideIcon> = {
  laptop: Laptop,
  desktop: Monitor,
  server: Server
}

/** The computer's own glyph (laptop, desktop or server); a desktop when it hasn't said. */
export function MachineGlyph({
  kind,
  ...icon
}: {
  kind: keyof typeof MACHINE_GLYPHS | null
  size: number
  color: string
  strokeWidth?: number
}) {
  const Glyph = kind ? MACHINE_GLYPHS[kind] : Monitor
  return <Glyph {...icon} />
}

const PROBLEM_VERDICTS: ReadonlySet<ConnectionVerdict['kind']> = new Set([
  'warning',
  'unreachable',
  'auth-failed'
])

function worktreeSummaries(info: HostWorktreeInfo | undefined, t: Translate) {
  const visual = homeHostWorktreeSummary(info)
  const accessibility =
    info && info.activeCount > 0 && (!info.catalogUnavailable || info.staleCounts)
      ? t(
          'components.hostCard.worktreeAccessibilitySummary',
          '{{summary}}, {{activeCount}} active',
          {
            summary: homeHostWorktreeSummary({ ...info, activeCount: 0 }),
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
  /** Agents on this computer waiting on the user. */
  needsYou: number
  onPress: () => void
  onLongPress: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  // No Relay is no evidence of an old desktop: current desktops make LAN-only pairings that never gain it.
  // Its why lives in the long-press sheet; the row says it in three words.
  // A Tailscale address keeps its "check Tailscale" hint: it may reach from anywhere.
  const sameNetworkOnly =
    props.verdict.kind === 'unreachable' &&
    !props.verdict.hint &&
    !props.host.relay &&
    !credentialMissing &&
    props.credentialStatus !== 'temporarily-unavailable'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
  const statusLabel = credentialMissing
    ? t('components.hostCard.pairingInvalid', 'Pairing invalid')
    : credentialUnavailable
      ? t('components.hostCard.pairingTemporarilyUnavailable', 'Pairing temporarily unavailable')
      : sameNetworkOnly
        ? t('components.hostCard.offlineSameWifiOnly', 'Offline · same Wi-Fi only')
        : verdictDisplayLabel(props.verdict, t)
  const statusVerdict: ConnectionVerdict = credentialMissing
    ? { kind: 'auth-failed', label: statusLabel }
    : credentialUnavailable
      ? { kind: 'warning', label: statusLabel }
      : props.verdict
  const dotColor = statusDotColor(colors, props.state, statusVerdict)
  // The words take the dot's severity, so an amber warning never reads red.
  const statusColor = PROBLEM_VERDICTS.has(statusVerdict.kind) ? dotColor : colors.textMuted
  const worktreeSummary = worktreeSummaries(props.worktreeInfo, t)
  const display = useHostDisplay(props.host)
  const credentialHint = credentialMissing
    ? t('components.hostCard.tapToPairAgain', 'Tap to pair again')
    : credentialUnavailable
      ? t('components.hostCard.unlockHint', 'Unlock your phone, then tap to retry')
      : null
  // The verdict's own second line (what to check on the desktop); credential copy wins.
  const verdictDetail =
    credentialHint === null && 'detail' in props.verdict ? (props.verdict.detail ?? null) : null
  const details = [credentialHint, verdictDetail].filter((line): line is string => Boolean(line))
  const statusLine = connected && worktreeSummary.visual ? worktreeSummary.visual : statusLabel
  const needsYou = connected ? props.needsYou : 0
  const needsYouLabel =
    needsYou > 0
      ? needsYou === 1
        ? t('components.hostCard.needsYou_one', '{{count}} needs you', { count: needsYou })
        : t('components.hostCard.needsYou_other', '{{count}} need you', { count: needsYou })
      : null
  const accessibilityLabel = [
    t('components.hostCard.openHost', 'Open {{title}}', { title: display.title }),
    display.machineLine ?? display.descriptorLine,
    statusLabel,
    connected ? mobileConnectionPathAccessibilityLabel(props.path, t) : null,
    connected ? worktreeSummary.accessibility : null,
    needsYouLabel,
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
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {display.title}
        </Text>
        {/* State then machine on one line keeps a desktop to two lines; a cut-off loses the machine. */}
        <Text style={styles.subtitle} numberOfLines={connected ? 1 : 2}>
          <Text style={{ color: statusColor }}>{statusLine}</Text>
          {display.machineLine ? ` · ${display.machineLine}` : ''}
        </Text>
        {details.map((line) => (
          <Text key={line} style={styles.detail} numberOfLines={3}>
            {line}
          </Text>
        ))}
      </View>
      <View style={styles.trailing}>
        {needsYou > 0 ? (
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{needsYou}</Text>
          </View>
        ) : null}
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
