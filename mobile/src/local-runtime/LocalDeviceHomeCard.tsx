import { useEffect, useState } from 'react'
import { Monitor, Smartphone } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { OrcaLocalRuntime, type LocalRuntimeStatus } from '../../modules/orca-local-runtime/src'
import { colors, radii, spacing } from '../theme/mobile-theme'

const STATUS_LABEL: Record<LocalRuntimeStatus['phase'], string> = {
  not_installed: 'Not set up',
  installing: 'Setting up…',
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  error: 'Needs attention'
}

/**
 * First thing on the standalone home screen: the host this phone runs itself, and the way into its
 * full desktop UI. Only mounted when canRunLocalHost(), so the native module is present.
 */
export function LocalDeviceHomeCard(props: { onOpenDesktop: () => void; onManage: () => void }) {
  const [status, setStatus] = useState<LocalRuntimeStatus | null>(
    () => OrcaLocalRuntime?.getStatus() ?? null
  )
  useEffect(() => {
    const sub = OrcaLocalRuntime?.addListener('onStatus', setStatus)
    return () => sub?.remove()
  }, [])

  const phase = status?.phase ?? 'not_installed'
  const desktopReady = phase === 'running' && status?.webClientUrl != null
  const dotColor =
    phase === 'running'
      ? colors.statusGreen
      : phase === 'error'
        ? colors.statusRed
        : colors.statusAmber

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <View style={styles.icon}>
          <Smartphone size={18} color={colors.textPrimary} />
        </View>
        <View style={styles.titleText}>
          <Text style={styles.title}>This phone</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <Text style={styles.status}>{STATUS_LABEL[phase]}</Text>
          </View>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !desktopReady }}
          disabled={!desktopReady}
          style={({ pressed }) => [
            styles.primary,
            !desktopReady && styles.disabled,
            pressed && styles.pressed
          ]}
          onPress={props.onOpenDesktop}
        >
          <Monitor size={16} color={colors.bgBase} />
          <Text style={styles.primaryLabel}>Desktop UI</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressedSecondary]}
          onPress={props.onManage}
        >
          <Text style={styles.secondaryLabel}>
            {phase === 'not_installed' ? 'Set up' : 'Manage'}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    padding: spacing.md,
    gap: spacing.md,
    marginBottom: spacing.lg
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  titleText: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: { color: colors.textSecondary, fontSize: 12 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  primary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright
  },
  primaryLabel: { color: colors.bgBase, fontSize: 14, fontWeight: '700' },
  secondary: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  pressedSecondary: { backgroundColor: colors.bgPanel }
})
