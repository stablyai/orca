import { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Bell,
  Wrench,
  Shield,
  LifeBuoy,
  Smartphone
} from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useAllHostClients } from '../src/transport/client-context'
import type { RpcClient } from '../src/transport/rpc-client'

// Why: mirrors the desktop labels but compressed to fit a phone row.
// The compact-summary form (rowSublabel) shows the *currently chosen*
// behavior in plain language; the option rows use the same compact
// phrasing. The server clamps anything outside [5_000, 60min].
// See docs/mobile-fit-hold.md.
const AUTO_RESTORE_FIT_OPTIONS: {
  value: string
  label: string
  ms: number | null
}[] = [
  { value: 'indefinite', label: 'Keep at phone size (default)', ms: null },
  { value: '60s', label: 'After 1 minute', ms: 60_000 },
  { value: '5m', label: 'After 5 minutes', ms: 5 * 60_000 },
  { value: '30m', label: 'After 30 minutes', ms: 30 * 60_000 }
]

function autoRestoreSummary(ms: number | null | undefined): string {
  if (ms === undefined) return '…'
  const exact = ms == null ? AUTO_RESTORE_FIT_OPTIONS[0]! : AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  return exact ? exact.label : `After ${Math.round(ms / 1000)}s`
}

// Why: a single small inline picker. We avoid pulling in a full picker
// dependency by toggling visible-rows on press — same pattern as the
// other lightweight inline pickers in the mobile shell.
function AutoRestoreFitRow({
  client,
  hostName
}: {
  client: RpcClient | null
  hostName: string
}): React.JSX.Element {
  const [ms, setMs] = useState<number | null | undefined>(undefined)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client
      .sendRequest('terminal.getAutoRestoreFit')
      .then((resp) => {
        if (cancelled) return
        const value = (resp as { ms?: number | null } | null)?.ms
        setMs(value === undefined ? null : value)
      })
      .catch(() => {
        if (!cancelled) setMs(null)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  async function selectOption(opt: { value: string; label: string; ms: number | null }) {
    if (!client) return
    setExpanded(false)
    setMs(opt.ms)
    try {
      const resp = (await client.sendRequest('terminal.setAutoRestoreFit', {
        ms: opt.ms
      })) as { ms?: number | null } | null
      const finalMs = resp?.ms === undefined ? null : resp.ms
      setMs(finalMs)
    } catch {
      // Server-side clamp/persistence failed; refetch to resync.
      try {
        const resp = (await client.sendRequest('terminal.getAutoRestoreFit')) as {
          ms?: number | null
        } | null
        setMs(resp?.ms === undefined ? null : resp.ms)
      } catch {
        // give up silently — the next mount retries
      }
    }
  }

  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => setExpanded((v) => !v)}
      >
        <Smartphone size={16} color={colors.textSecondary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{hostName}</Text>
          <Text style={styles.rowSublabel}>{autoRestoreSummary(ms)}</Text>
        </View>
        <ChevronRight
          size={16}
          color={colors.textMuted}
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
      </Pressable>
      {expanded &&
        AUTO_RESTORE_FIT_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            style={({ pressed }) => [
              styles.optionRow,
              pressed && styles.rowPressed,
              opt.ms === (ms ?? null) && styles.optionRowSelected
            ]}
            onPress={() => void selectOption(opt)}
          >
            <Text style={styles.optionLabel}>{opt.label}</Text>
          </Pressable>
        ))}
    </View>
  )
}

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const hostClients = useAllHostClients(hostIds)

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Settings</Text>
      </View>

      <View style={styles.section}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/notifications')}
        >
          <Bell size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Notifications</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/troubleshoot')}
        >
          <Wrench size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Troubleshooting</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/about')}
        >
          <Info size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>About</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      {hosts.length > 0 && (
        <View style={[styles.section, styles.sectionSpacer]}>
          <Text style={styles.sectionHeading}>When you leave the app</Text>
          {hosts.map((host, idx) => {
            const entry = hostClients.find((e) => e.hostId === host.id)
            return (
              <View key={host.id}>
                {idx > 0 && <View style={styles.separator} />}
                <AutoRestoreFitRow client={entry?.client ?? null} hostName={host.name} />
              </View>
            )
          })}
        </View>
      )}

      <View style={[styles.section, styles.sectionSpacer]}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => void Linking.openURL('https://www.onorca.dev/privacy')}
        >
          <Shield size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Privacy Policy</Text>
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => void Linking.openURL('https://github.com/stablyai/orca/issues')}
        >
          <LifeBuoy size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>Support</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  sectionSpacer: {
    marginTop: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  sectionHeading: {
    fontSize: typography.bodySize - 2,
    fontWeight: '600',
    color: colors.textSecondary,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.xs
  },
  optionRow: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md + 2 + 22 + spacing.sm + 2,
    backgroundColor: colors.bgRaised
  },
  optionRowSelected: {
    backgroundColor: colors.bgPanel
  },
  optionLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
