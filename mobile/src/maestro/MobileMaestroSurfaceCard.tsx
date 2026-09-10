import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FileText, Globe, SquareTerminal } from 'lucide-react-native'
import type { WorkspaceSurface } from '../../../src/shared/maestro-workspace-canvas'
import type { RpcClient } from '../transport/rpc-client'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { MobileMaestroTerminalPreview } from './MobileMaestroTerminalPreview'

const TONE_COLOR = {
  decision: colors.statusGreen,
  warning: colors.statusAmber,
  blocked: colors.statusRed,
  observation: colors.textMuted
} as const

const TONE_LABEL = {
  decision: 'Decision',
  warning: 'Warning',
  blocked: 'Blocked',
  observation: 'Observation'
} as const

export function MobileMaestroSurfaceCard({
  surface,
  selected,
  preview,
  client,
  worktreeId,
  livePreview,
  onPress
}: {
  surface: WorkspaceSurface
  selected: boolean
  preview?: string
  client: RpcClient | null
  worktreeId: string | null
  livePreview: boolean
  onPress: () => void
}) {
  const tone = surface.binding.kind === 'content' ? surface.binding.annotation?.tone : undefined
  const Icon =
    surface.binding.kind === 'terminal'
      ? SquareTerminal
      : surface.binding.kind === 'browser'
        ? Globe
        : FileText
  const detail =
    surface.binding.kind === 'terminal'
      ? surface.binding.liveness === 'live'
        ? 'Live PTY'
        : surface.binding.liveness
      : surface.binding.kind === 'browser'
        ? surface.binding.live_frame
          ? 'Live Browser frame'
          : surface.binding.immutable_capture
            ? 'Captured Browser page'
            : 'Exact Browser page'
        : (surface.binding.source?.relative_path ?? surface.binding.content_type)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Select ${surface.title}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        tone ? { borderLeftColor: TONE_COLOR[tone], borderLeftWidth: 4 } : null,
        selected && styles.selected,
        pressed && styles.pressed
      ]}
      testID={`maestro-surface-${surface.id.unified_tab_id}`}
    >
      <View style={styles.header}>
        <View style={styles.iconFrame}>
          <Icon size={13} color={tone ? TONE_COLOR[tone] : colors.textSecondary} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {surface.title}
        </Text>
        <View style={styles.availabilityLabel}>
          <View
            style={[styles.availability, surface.availability === 'available' && styles.live]}
          />
          <Text style={styles.availabilityText}>
            {surface.availability === 'available' ? 'Live' : surface.availability}
          </Text>
        </View>
      </View>
      {surface.binding.kind === 'terminal' ? (
        <MobileMaestroTerminalPreview
          active={livePreview && surface.binding.liveness === 'live'}
          client={client}
          terminalTabId={surface.binding.terminal_tab_id}
          paneKey={surface.binding.pane_key}
          sessionId={surface.binding.session_id}
          worktreeId={worktreeId}
        />
      ) : (
        <View style={styles.contentPreview}>
          {tone ? (
            <Text style={[styles.tone, { color: TONE_COLOR[tone] }]}>{TONE_LABEL[tone]}</Text>
          ) : null}
          <Text style={styles.preview} numberOfLines={7}>
            {preview ?? detail}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {surface.content_type} · rev {surface.revision}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    backgroundColor: colors.editorSurface,
    overflow: 'hidden'
  },
  selected: { borderColor: colors.accentBlue, borderWidth: 2 },
  pressed: { opacity: 0.82 },
  header: {
    minHeight: 40,
    paddingHorizontal: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  iconFrame: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  title: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  availabilityLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  availability: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusAmber },
  live: { backgroundColor: colors.statusGreen },
  availabilityText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  contentPreview: { flex: 1, padding: spacing.md },
  tone: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7
  },
  preview: {
    flex: 1,
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18,
    fontFamily: typography.monoFamily
  },
  meta: { marginTop: spacing.sm, color: colors.textMuted, fontSize: 10 }
})
