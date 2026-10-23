import { ChevronRight, Ellipsis } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { CompatVerdict } from '../transport/protocol-compat'
import { useHostDisplay } from '../transport/use-host-display'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { IconButton } from './ui/IconButton'
import { LIST_ROW_PADDING } from './ui/ListGroup'
import { pressTransition } from './ui/transition-styles'
import { StatusDot, statusDotColor } from './StatusDot'

function sentence(text: string): string {
  const trimmed = text.trim()
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?…]$/.test(capitalised) ? capitalised : `${capitalised}.`
}

/** A desktop's row in Home's "Desktops" group: dot, name, one status line, the remedy, "…" and a chevron. */
export function MobileHostCard(props: {
  host: HostProfile | HostCatalogEntry
  credentialStatus?: HostCatalogEntry['credentialStatus']
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // Why: the card owns the fresh/stale/unavailable wording so no caller can re-gate the counts
  // away (STA-3123 shipped that bug once already).
  worktreeInfo?: HostWorktreeInfo
  /** The desktop's protocol verdict once it has answered status.get; blocked reads "Update needed". */
  compatVerdict?: CompatVerdict
  onPress: () => void
  onLongPress: () => void
  onOpenActions: () => void
}) {
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
  const compat = props.compatVerdict
  const updateNeeded = connected && compat?.kind === 'blocked'
  // Why: one verdict feeds both the dot and the text, so a warning stays amber in both.
  const statusVerdict: ConnectionVerdict = credentialMissing
    ? { kind: 'auth-failed', label: 'Pairing invalid' }
    : credentialUnavailable
      ? { kind: 'warning', label: 'Pairing temporarily unavailable' }
      : updateNeeded
        ? { kind: 'warning', label: 'Update needed' }
        : props.verdict
  // The short label; the remedy goes on its own wrapping line so it is never the part cut off.
  const statusLabel = statusVerdict.kind === 'auth-failed' ? 'Pairing invalid' : statusVerdict.label
  const statusColor =
    connected && statusVerdict.kind === 'normal'
      ? colors.textSecondary
      : statusDotColor(props.state, statusVerdict)
  const worktreeSummary =
    connected && !updateNeeded ? homeHostWorktreeSummary(props.worktreeInfo) : null
  const connectionPathLabel =
    connected && !updateNeeded ? mobileConnectionPathLabel(props.path) : null
  const display = useHostDisplay(props.host)
  const remedy = hostRowRemedy({
    credentialMissing,
    credentialUnavailable,
    compat: updateNeeded ? compat : undefined,
    verdict: props.verdict,
    hasRelay: Boolean(props.host.relay)
  })
  const details = [worktreeSummary, connectionPathLabel].filter((part): part is string =>
    Boolean(part)
  )
  const accessibilityLabel = [
    `Open ${display.title}`,
    display.descriptorLine,
    statusLabel,
    connectionPathLabel?.replace(' · ', ' via '),
    worktreeSummary?.replace(' · ', ', '),
    remedy
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Touch and hold for actions"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={400}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.leading}>
            <StatusDot state={props.state} verdict={statusVerdict} size={10} />
          </View>
          <View style={styles.main}>
            <Text style={styles.name} numberOfLines={1}>
              {display.title}
            </Text>
            <Text style={styles.status} numberOfLines={2}>
              <Text style={{ color: statusColor }}>{statusLabel}</Text>
              {details.length > 0 ? ` · ${details.join(' · ')}` : ''}
            </Text>
            {remedy ? <Text style={styles.remedy}>{remedy}</Text> : null}
          </View>
          <IconButton
            icon={Ellipsis}
            iconSize={18}
            iconColor={colors.textSecondary}
            accessibilityLabel={`Actions for ${display.title}`}
            onPress={props.onOpenActions}
          />
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
        </View>
      )}
    </Pressable>
  )
}

/** What to do about the row's state, in full sentences; null when nothing is wrong. */
function hostRowRemedy(args: {
  credentialMissing: boolean
  credentialUnavailable: boolean
  compat: CompatVerdict | undefined
  verdict: ConnectionVerdict
  hasRelay: boolean
}): string | null {
  if (args.credentialMissing) {
    return 'Tap to re-pair with your desktop.'
  }
  if (args.credentialUnavailable) {
    return 'Unlock your phone, then tap to retry.'
  }
  if (args.compat?.kind === 'blocked') {
    return args.compat.reason === 'mobile-too-old'
      ? 'Update Orca Mobile to use this desktop.'
      : 'Update Orca on this desktop to connect.'
  }
  const { verdict } = args
  if (verdict.kind === 'auth-failed') {
    return 'Re-pair with your desktop.'
  }
  if (verdict.kind !== 'warning' && verdict.kind !== 'unreachable') {
    return null
  }
  const parts = [verdict.hint, verdict.detail].filter((part): part is string => Boolean(part))
  if (verdict.kind === 'unreachable' && !args.hasRelay) {
    parts.push('Update desktop Orca and sign in to connect from anywhere')
  }
  return parts.length > 0 ? parts.map(sentence).join(' ') : null
}

// The title line's height, so the dot centres on the name.
const TITLE_LINE = textStyles.body.lineHeight

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: LIST_ROW_PADDING,
    paddingRight: LIST_ROW_PADDING - 4,
    paddingVertical: spacing.md
  },
  pressed: { backgroundColor: colors.fill },
  leading: {
    width: 28,
    height: TITLE_LINE,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center'
  },
  main: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  status: {
    ...textStyles.subhead,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  remedy: { ...textStyles.footnote, color: colors.textMuted, marginTop: 2 }
})
