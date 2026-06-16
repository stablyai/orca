import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useAllHostClients } from '../src/transport/client-context'
import type { RpcClient } from '../src/transport/rpc-client'
import { BottomDrawer } from '../src/components/BottomDrawer'
import { VoiceModelList } from '../src/components/VoiceModelList'
import {
  downloadDictationModel,
  fetchDictationSetup,
  isModelInFlight,
  setDictationConfig,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../src/dictation/mobile-dictation-setup'

const POLL_INTERVAL_MS = 1500

const DICTATION_MODES = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Hold' }
] as const

export default function VoiceSettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const hostClients = useAllHostClients(hostIds)
  // Voice dictation runs on the paired desktop, so pick the first connected host.
  const client: RpcClient | null = useMemo(
    () => hostClients.find((entry) => entry.state === 'connected')?.client ?? null,
    [hostClients]
  )

  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyModelId, setBusyModelId] = useState<string | null>(null)
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    try {
      setSetup(await fetchDictationSetup(client))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load voice settings')
    }
  }, [client])

  // Initial load once a connected client is available.
  useEffect(() => {
    if (!client) {
      return
    }
    setLoading(true)
    setError(null)
    void refresh().finally(() => setLoading(false))
  }, [client, refresh])

  // Poll only while a model is downloading/extracting; stop otherwise.
  useEffect(() => {
    const inFlight = setup?.models.some(isModelInFlight) ?? false
    if (inFlight && client) {
      pollRef.current = setInterval(() => void refresh(), POLL_INTERVAL_MS)
      return () => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }
    }
    return undefined
  }, [setup, client, refresh])

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!client) {
        return
      }
      setError(null)
      // Optimistic flip so the switch responds instantly; reconcile below.
      setSetup((prev) => (prev ? { ...prev, enabled } : prev))
      try {
        setSetup(await setDictationConfig(client, { enabled }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update')
        void refresh()
      }
    },
    [client, refresh]
  )

  const handleSelectMode = useCallback(
    async (dictationMode: 'toggle' | 'hold') => {
      if (!client) {
        return
      }
      setError(null)
      setSetup((prev) => (prev ? { ...prev, dictationMode } : prev))
      try {
        setSetup(await setDictationConfig(client, { dictationMode }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update')
        void refresh()
      }
    },
    [client, refresh]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusyModelId(model.id)
      setError(null)
      try {
        setSetup(await setDictationConfig(client, { enabled: true, modelId: model.id }))
        setModelDrawerOpen(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not select model')
      } finally {
        setBusyModelId(null)
      }
    },
    [client]
  )

  const handleDownload = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusyModelId(model.id)
      setError(null)
      try {
        await downloadDictationModel(client, model.id)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Download failed')
      } finally {
        setBusyModelId(null)
      }
    },
    [client, refresh]
  )

  const enabled = setup?.enabled ?? false
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel = selectedModel?.label ?? 'None selected'

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Voice</Text>
      </View>

      {!client ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.emptyText}>Connect to a desktop to manage voice settings.</Text>
        </View>
      ) : loading && setup === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : setup === null ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.errorText}>{error ?? 'Failed to load voice settings.'}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.groupHeading}>DICTATION</Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>Enable Voice Dictation</Text>
                <Text style={styles.rowSublabel}>
                  Dictate text into any focused pane on your desktop.
                </Text>
              </View>
              <Switch
                value={enabled}
                onValueChange={(v) => void handleToggleEnabled(v)}
                trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                thumbColor={colors.textPrimary}
              />
            </View>

            <View style={styles.separator} />

            <View
              style={[styles.row, !enabled && styles.disabled]}
              pointerEvents={enabled ? 'auto' : 'none'}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>Dictation Mode</Text>
                <Text style={styles.rowSublabel}>
                  Toggle: press once to start, again to stop. Hold: dictate while held.
                </Text>
              </View>
              <View style={styles.segmented}>
                {DICTATION_MODES.map((mode) => {
                  const active = setup.dictationMode === mode.value
                  return (
                    <Pressable
                      key={mode.value}
                      onPress={() => void handleSelectMode(mode.value)}
                      style={[styles.segment, active && styles.segmentActive]}
                    >
                      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                        {mode.label}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          </View>

          <Text style={[styles.groupHeading, styles.inputGroupGap]}>SPEECH MODEL</Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                !enabled && styles.disabled,
                pressed && styles.rowPressed
              ]}
              disabled={!enabled}
              onPress={() => setModelDrawerOpen(true)}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>Speech Model</Text>
                <Text style={styles.rowSublabel} numberOfLines={1}>
                  {selectedModelLabel}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
      )}

      <BottomDrawer visible={modelDrawerOpen} onClose={() => setModelDrawerOpen(false)}>
        <Text style={styles.drawerTitle}>Speech Model</Text>
        {setup ? (
          <VoiceModelList
            setup={setup}
            disabled={false}
            busyModelId={busyModelId}
            onUseModel={(m) => void handleUseModel(m)}
            onDownload={(m) => void handleDownload(m)}
          />
        ) : null}
      </BottomDrawer>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
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
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  sectionTopGap: { marginTop: spacing.sm },
  inputGroupGap: { marginTop: spacing.xl },
  disabled: { opacity: 0.5 },
  emptyText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    padding: spacing.md
  },
  errorText: {
    fontSize: typography.bodySize,
    color: colors.statusRed,
    padding: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowContent: { flex: 1 },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  drawerTitle: {
    fontSize: typography.bodySize,
    fontWeight: '700',
    color: colors.textPrimary,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
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
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.button,
    padding: 2
  },
  segment: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.button - 1
  },
  segmentActive: { backgroundColor: colors.bgRaised },
  segmentText: { fontSize: typography.metaSize, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary },
  error: { color: colors.statusRed, fontSize: typography.metaSize, marginTop: spacing.md }
})
