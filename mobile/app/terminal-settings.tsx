import { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, Smartphone } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useAllHostClients } from '../src/transport/client-context'
import type { RpcClient } from '../src/transport/rpc-client'
import { PickerModal, type PickerOption } from '../src/components/PickerModal'

type RestoreValue = 'indefinite' | '60s' | '5m' | '30m'

const AUTO_RESTORE_FIT_OPTIONS: (PickerOption<RestoreValue> & { ms: number | null })[] = [
  { value: 'indefinite', label: 'Keep at phone size (default)', ms: null },
  { value: '60s', label: 'After 1 minute', ms: 60_000 },
  { value: '5m', label: 'After 5 minutes', ms: 5 * 60_000 },
  { value: '30m', label: 'After 30 minutes', ms: 30 * 60_000 }
]

function valueFromMs(ms: number | null | undefined): RestoreValue {
  if (ms == null) return 'indefinite'
  const exact = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  if (exact) return exact.value
  // Why: server may return a non-preset ms (custom value, future preset,
  // or server-side clamp). Snap to the closest finite preset so the
  // picker's selected radio agrees with the row sublabel rendered by
  // autoRestoreSummary ("After Xs").
  let closest: (typeof AUTO_RESTORE_FIT_OPTIONS)[number] | null = null
  let bestDelta = Infinity
  for (const opt of AUTO_RESTORE_FIT_OPTIONS) {
    if (opt.ms == null) continue
    const delta = Math.abs(opt.ms - ms)
    if (delta < bestDelta) {
      bestDelta = delta
      closest = opt
    }
  }
  return closest ? closest.value : 'indefinite'
}

function autoRestoreSummary(ms: number | null | undefined): string {
  if (ms === undefined) return '…'
  if (ms === null) return AUTO_RESTORE_FIT_OPTIONS[0]!.label
  const exact = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  return exact ? exact.label : `After ${Math.round(ms / 1000)}s`
}

function HostFitRow({
  client,
  hostName,
  ms,
  onPress
}: {
  client: RpcClient | null
  hostName: string
  ms: number | null | undefined
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      disabled={!client}
    >
      <Smartphone size={16} color={colors.textSecondary} />
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{hostName}</Text>
        <Text style={styles.rowSublabel}>{autoRestoreSummary(ms)}</Text>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

export default function TerminalSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const hostClients = useAllHostClients(hostIds)

  // Why: per-host current value, lazily fetched. We keep state at the
  // screen level rather than per-row so the picker can render at root
  // level — embedding PickerModal inside a row clipped its BottomDrawer
  // absoluteFill backdrop to the ScrollView content frame and made the
  // drawer appear cut-off.
  const [hostMs, setHostMs] = useState<Record<string, number | null | undefined>>({})
  const [pickerHostId, setPickerHostId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    for (const host of hosts) {
      const entry = hostClients.find((e) => e.hostId === host.id)
      const client = entry?.client ?? null
      if (!client) continue
      void client
        .sendRequest('terminal.getAutoRestoreFit')
        .then((resp) => {
          if (cancelled) return
          const value = (resp as { ms?: number | null } | null)?.ms
          setHostMs((prev) => ({ ...prev, [host.id]: value === undefined ? null : value }))
        })
        .catch(() => {
          if (!cancelled) setHostMs((prev) => ({ ...prev, [host.id]: null }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [hosts, hostClients])

  async function selectValue(hostId: string, value: RestoreValue) {
    const entry = hostClients.find((e) => e.hostId === hostId)
    const client = entry?.client ?? null
    if (!client) return
    const opt = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.value === value)
    if (!opt) return
    setHostMs((prev) => ({ ...prev, [hostId]: opt.ms }))
    try {
      const resp = (await client.sendRequest('terminal.setAutoRestoreFit', {
        ms: opt.ms
      })) as { ms?: number | null } | null
      const finalMs = resp?.ms === undefined ? null : resp.ms
      setHostMs((prev) => ({ ...prev, [hostId]: finalMs }))
    } catch {
      try {
        const resp = (await client.sendRequest('terminal.getAutoRestoreFit')) as {
          ms?: number | null
        } | null
        setHostMs((prev) => ({
          ...prev,
          [hostId]: resp?.ms === undefined ? null : resp.ms
        }))
      } catch {
        // give up silently — the next mount retries
      }
    }
  }

  const pickerHost = pickerHostId ? hosts.find((h) => h.id === pickerHostId) : null

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Terminal</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupHeading}>WHEN YOU LEAVE THE APP</Text>
        <Text style={styles.groupDescription}>
          While you&apos;re using a terminal on your phone, Orca shrinks it to fit your screen. When
          you close the app or switch away, this controls whether it stays at phone size (so
          interactive CLI tools don&apos;t reflow) or resizes back to your desktop. You can always
          tap Restore on the terminal banner to resize it manually.
        </Text>

        {hosts.length === 0 ? (
          <View style={[styles.section, styles.sectionTopGap]}>
            <Text style={styles.emptyText}>
              No paired desktops yet. Pair one to control terminal behavior.
            </Text>
          </View>
        ) : (
          <View style={[styles.section, styles.sectionTopGap]}>
            {hosts.map((host, idx) => {
              const entry = hostClients.find((e) => e.hostId === host.id)
              return (
                <View key={host.id}>
                  {idx > 0 && <View style={styles.separator} />}
                  <HostFitRow
                    client={entry?.client ?? null}
                    hostName={host.name}
                    ms={hostMs[host.id]}
                    onPress={() => setPickerHostId(host.id)}
                  />
                </View>
              )
            })}
          </View>
        )}
      </ScrollView>

      <PickerModal<RestoreValue>
        visible={pickerHost != null}
        title={pickerHost ? `Restore ${pickerHost.name}` : ''}
        options={AUTO_RESTORE_FIT_OPTIONS}
        selected={valueFromMs(pickerHost ? hostMs[pickerHost.id] : null)}
        onSelect={(v) => {
          if (pickerHost) void selectValue(pickerHost.id, v)
        }}
        onClose={() => setPickerHostId(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg,
    paddingTop: 0
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg
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
  scrollContent: {
    paddingBottom: spacing.xl
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
  },
  emptyText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    padding: spacing.md
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
  rowContent: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
