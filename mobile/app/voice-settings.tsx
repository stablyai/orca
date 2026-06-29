import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useAllHostClients } from '../src/transport/client-context'
import type { RpcClient } from '../src/transport/rpc-client'
import { BottomDrawer } from '../src/components/BottomDrawer'
import { VoiceModelList } from '../src/components/VoiceModelList'
import {
  deleteDictationModel,
  downloadDictationModel,
  fetchDictationSetup,
  isModelInFlight,
  setDictationConfig,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../src/dictation/mobile-dictation-setup'
import { useTranslate } from '../src/i18n/useTranslate'
import { styles } from './voice-settings-styles'

const POLL_INTERVAL_MS = 1500

type TranslateFn = (key: string, fallback: string, options?: Record<string, unknown>) => string

function buildDictationModes(t: TranslateFn) {
  return [
    { value: 'toggle', label: t('mobile.voiceSettings.modeToggle', 'Toggle') },
    { value: 'hold', label: t('mobile.voiceSettings.modeHold', 'Hold') }
  ] as const
}

type ModelBusyAction = { modelId: string; type: 'download' | 'select' | 'delete' }

export default function VoiceSettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { t } = useTranslate()
  const dictationModes = buildDictationModes(t)

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
  const [busyAction, setBusyAction] = useState<ModelBusyAction | null>(null)
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
      setError(
        err instanceof Error
          ? err.message
          : t('mobile.voiceSettings.failedToLoad', 'Failed to load voice settings')
      )
    }
  }, [client, t])

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
        setError(
          err instanceof Error
            ? err.message
            : t('mobile.voiceSettings.couldNotUpdate', 'Could not update')
        )
        void refresh()
      }
    },
    [client, refresh, t]
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
        setError(
          err instanceof Error
            ? err.message
            : t('mobile.voiceSettings.couldNotUpdate', 'Could not update')
        )
        void refresh()
      }
    },
    [client, refresh, t]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusyAction({ modelId: model.id, type: 'select' })
      setError(null)
      try {
        setSetup(await setDictationConfig(client, { enabled: true, modelId: model.id }))
        setModelDrawerOpen(false)
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('mobile.voiceSettings.couldNotSelect', 'Could not select model')
        )
      } finally {
        setBusyAction(null)
      }
    },
    [client, t]
  )

  const handleDownload = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      setBusyAction({ modelId: model.id, type: 'download' })
      setError(null)
      try {
        await downloadDictationModel(client, model.id)
        await refresh()
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('mobile.voiceSettings.downloadFailed', 'Download failed')
        )
      } finally {
        setBusyAction(null)
      }
    },
    [client, refresh, t]
  )

  const handleDelete = useCallback(
    async (model: MobileSpeechModel) => {
      if (!client) {
        return
      }
      const deletedSelectedModel = setup?.selectedModelId === model.id
      setBusyAction({ modelId: model.id, type: 'delete' })
      setError(null)
      try {
        setSetup(await deleteDictationModel(client, model.id))
        if (deletedSelectedModel) {
          setModelDrawerOpen(false)
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('mobile.voiceSettings.deleteFailed', 'Delete failed')
        )
      } finally {
        setBusyAction(null)
      }
    },
    [client, setup?.selectedModelId, t]
  )

  const enabled = setup?.enabled ?? false
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel =
    selectedModel?.label ?? t('mobile.voiceSettings.noneSelected', 'None selected')

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('mobile.voiceSettings.title', 'Voice')}</Text>
      </View>

      {!client ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.emptyText}>
            {t(
              'mobile.voiceSettings.connectFirst',
              'Connect to a desktop to manage voice settings.'
            )}
          </Text>
        </View>
      ) : loading && setup === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : setup === null ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.errorText}>
            {error ?? t('mobile.voiceSettings.loadError', 'Failed to load voice settings.')}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.groupHeading}>
            {t('mobile.voiceSettings.dictation', 'DICTATION')}
          </Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>
                  {t('mobile.voiceSettings.enableDictation', 'Enable Voice Dictation')}
                </Text>
                <Text style={styles.rowSublabel}>
                  {t(
                    'mobile.voiceSettings.enableDictationSub',
                    'Dictate text into any focused pane on your desktop.'
                  )}
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
                <Text style={styles.rowLabel}>
                  {t('mobile.voiceSettings.dictationMode', 'Dictation Mode')}
                </Text>
                <Text style={styles.rowSublabel}>
                  {t(
                    'mobile.voiceSettings.dictationModeSub',
                    'Toggle: press once to start, again to stop. Hold: dictate while held.'
                  )}
                </Text>
              </View>
              <View style={styles.segmented}>
                {dictationModes.map((mode) => {
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

          <Text style={[styles.groupHeading, styles.inputGroupGap]}>
            {t('mobile.voiceSettings.speechModel', 'SPEECH MODEL')}
          </Text>
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
                <Text style={styles.rowLabel}>
                  {t('mobile.voiceSettings.speechModelLabel', 'Speech Model')}
                </Text>
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
        <Text style={styles.drawerTitle}>
          {t('mobile.voiceSettings.drawerTitle', 'Speech Model')}
        </Text>
        {setup ? (
          <VoiceModelList
            setup={setup}
            disabled={false}
            busyAction={busyAction}
            onUseModel={(m) => void handleUseModel(m)}
            onDownload={(m) => void handleDownload(m)}
            onDelete={(m) => void handleDelete(m)}
          />
        ) : null}
      </BottomDrawer>
    </View>
  )
}
