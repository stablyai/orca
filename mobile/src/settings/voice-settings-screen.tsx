import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { voiceSettingsStyles as styles } from './voice-settings-styles'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { VoiceModelList } from '../components/VoiceModelList'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'
import { MobileSwitch } from '../components/MobileSwitch'

const POLL_INTERVAL_MS = 1500

function dictationModes(t: Translate) {
  return [
    { value: 'toggle', label: t('settings.voiceSettingsScreen.toggleMode', 'Toggle') },
    { value: 'hold', label: t('settings.voiceSettingsScreen.holdMode', 'Hold') }
  ] as const
}

type ModelBusyAction = { modelId: string; type: 'download' | 'select' | 'delete' }
type VoiceSettingsError =
  | { message: string }
  | 'loadFailed'
  | 'updateFailed'
  | 'selectModelFailed'
  | 'downloadFailed'
  | 'deleteFailed'

function voiceSettingsErrorMessage(t: Translate, error: VoiceSettingsError | null): string | null {
  if (error === null) {
    return null
  }
  if (typeof error === 'object') {
    return error.message
  }
  switch (error) {
    case 'loadFailed':
      return t('settings.voiceSettingsScreen.loadFailed', 'Failed to load voice settings')
    case 'updateFailed':
      return t('settings.voiceSettingsScreen.updateFailed', 'Could not update')
    case 'selectModelFailed':
      return t('settings.voiceSettingsScreen.selectModelFailed', 'Could not select model')
    case 'downloadFailed':
      return t('settings.voiceSettingsScreen.downloadFailed', 'Download failed')
    case 'deleteFailed':
      return t('settings.voiceSettingsScreen.deleteFailed', 'Delete failed')
  }
}

export default function VoiceSettingsScreen({
  operations,
  focused,
  onBack
}: {
  operations: VoiceSettingsOperations | null
  focused: boolean
  onBack: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [loading, setLoading] = useState(true)
  // A read clears only its own failure, so a background re-read cannot hide why a change failed.
  const [loadError, setLoadError] = useState<VoiceSettingsError | null>(null)
  const [error, setError] = useState<VoiceSettingsError | null>(null)
  const [busyAction, setBusyAction] = useState<ModelBusyAction | null>(null)
  const requestEpoch = useRef(0)
  const pendingChanges = useRef(0)
  const rereadWhenSettled = useRef(false)
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!operations) {
      return false
    }
    // A read sent during a change can predate it: the host clears a deleted model only after removing its files.
    if (pendingChanges.current > 0) {
      return undefined
    }
    const epoch = requestEpoch.current
    // The serialized read owns its spinner so retries hide stale errors and no competing read clears it.
    setLoading(true)
    try {
      const next = await operations.load()
      if (epoch !== requestEpoch.current) {
        return undefined
      }
      setSetup(next)
      setLoadError(null)
      return next.models.some(isModelInFlight)
    } catch (err) {
      if (epoch === requestEpoch.current) {
        setLoadError(err instanceof Error ? { message: err.message } : 'loadFailed')
      }
      return undefined
    } finally {
      setLoading(false)
    }
  }, [operations])

  const polling = setup?.models.some(isModelInFlight) ?? false
  const refreshSetup = useDictationSetupPoller({
    visible: focused && operations !== null,
    polling,
    refresh,
    intervalMs: POLL_INTERVAL_MS
  })

  // Only the newest change's reply is applied; after a skipped reply or a failure, re-read once all changes settle.
  const sendChange = useCallback(
    async <T,>(
      send: () => Promise<T>
    ): Promise<
      { ok: true; reply: T; latest: boolean } | { ok: false; error: unknown; latest: boolean }
    > => {
      const epoch = ++requestEpoch.current
      pendingChanges.current += 1
      try {
        const reply = await send()
        const latest = epoch === requestEpoch.current
        rereadWhenSettled.current ||= !latest
        return { ok: true, reply, latest }
      } catch (error) {
        rereadWhenSettled.current = true
        return { ok: false, error, latest: epoch === requestEpoch.current }
      } finally {
        pendingChanges.current -= 1
        if (pendingChanges.current === 0 && rereadWhenSettled.current) {
          rereadWhenSettled.current = false
          void refreshSetup()
        }
      }
    },
    [refreshSetup]
  )

  const configure = useCallback(
    async (params: Parameters<VoiceSettingsOperations['configure']>[0]) => {
      if (!operations) {
        return
      }
      setError(null)
      const { enabled, dictationMode } = params
      setSetup((prev) =>
        prev
          ? {
              ...prev,
              ...(enabled === undefined ? {} : { enabled }),
              ...(dictationMode === undefined ? {} : { dictationMode })
            }
          : prev
      )
      const result = await sendChange(() => operations.configure(params))
      if (!result.latest) {
        return
      }
      if (result.ok) {
        setSetup(result.reply)
      } else {
        setError(result.error instanceof Error ? { message: result.error.message } : 'updateFailed')
      }
    },
    [operations, sendChange]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      setBusyAction({ modelId: model.id, type: 'select' })
      setError(null)
      const result = await sendChange(() =>
        operations.configure({ enabled: true, modelId: model.id })
      )
      if (!result.ok) {
        setError(
          result.error instanceof Error ? { message: result.error.message } : 'selectModelFailed'
        )
      } else if (result.latest) {
        setSetup(result.reply)
        setModelDrawerOpen(false)
      }
      setBusyAction(null)
    },
    [operations, sendChange]
  )

  const handleDownload = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      requestEpoch.current += 1
      setBusyAction({ modelId: model.id, type: 'download' })
      setError(null)
      try {
        await operations.download(model.id)
        await refreshSetup()
      } catch (err) {
        setError(err instanceof Error ? { message: err.message } : 'downloadFailed')
      } finally {
        setBusyAction(null)
      }
    },
    [operations, refreshSetup]
  )

  const handleDelete = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      const deletedSelectedModel = setup?.selectedModelId === model.id
      setBusyAction({ modelId: model.id, type: 'delete' })
      setError(null)
      const result = await sendChange(() => operations.delete(model.id))
      if (!result.ok) {
        setError(result.error instanceof Error ? { message: result.error.message } : 'deleteFailed')
      } else if (result.latest) {
        setSetup(result.reply)
        if (deletedSelectedModel) {
          setModelDrawerOpen(false)
        }
      }
      setBusyAction(null)
    },
    [operations, sendChange, setup?.selectedModelId]
  )

  const enabled = setup?.enabled ?? false
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel =
    selectedModel?.label ?? t('settings.voiceSettingsScreen.noneSelected', 'None selected')
  const loadErrorMessage = voiceSettingsErrorMessage(t, loadError)
  const errorMessage = voiceSettingsErrorMessage(t, error)

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('settings.voiceSettingsScreen.title', 'Voice')}</Text>
      </View>

      {!operations ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.emptyText}>
            {t(
              'settings.voiceSettingsScreen.connectDesktop',
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
            {loadErrorMessage ??
              t('settings.voiceSettingsScreen.loadFailedMessage', 'Failed to load voice settings.')}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.groupHeading}>
            {t('settings.voiceSettingsScreen.dictationHeading', 'DICTATION')}
          </Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>
                  {t('settings.voiceSettingsScreen.enableDictation', 'Enable Voice Dictation')}
                </Text>
                <Text style={styles.rowSublabel}>
                  {t(
                    'settings.voiceSettingsScreen.dictationDescription',
                    'Dictate text into any focused pane on your desktop.'
                  )}
                </Text>
              </View>
              <MobileSwitch
                testID="voice-enabled"
                accessibilityLabel={t(
                  'settings.voiceSettingsScreen.enableDictation',
                  'Enable Voice Dictation'
                )}
                value={enabled}
                onValueChange={(enabled) => void configure({ enabled })}
              />
            </View>

            <View style={styles.separator} />

            <View
              style={[styles.row, !enabled && styles.disabled]}
              pointerEvents={enabled ? 'auto' : 'none'}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>
                  {t('settings.voiceSettingsScreen.dictationMode', 'Dictation Mode')}
                </Text>
                <Text style={styles.rowSublabel}>
                  {t(
                    'settings.voiceSettingsScreen.dictationModeDescription',
                    'Toggle: press once to start, again to stop. Hold: dictate while held.'
                  )}
                </Text>
              </View>
              <MobileSegmentedControl
                segments={dictationModes(t)}
                selected={setup.dictationMode}
                onSelect={(dictationMode) => void configure({ dictationMode })}
                testIDPrefix="voice-mode-"
              />
            </View>
          </View>

          <Text style={[styles.groupHeading, styles.inputGroupGap]}>
            {t('settings.voiceSettingsScreen.speechModelHeading', 'SPEECH MODEL')}
          </Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <Pressable
              style={({ pressed }) => [
                styles.row,
                !enabled && styles.disabled,
                pressed && styles.rowPressed
              ]}
              disabled={!enabled}
              testID="voice-model-picker"
              onPress={() => setModelDrawerOpen(true)}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>
                  {t('settings.voiceSettingsScreen.speechModel', 'Speech Model')}
                </Text>
                <Text style={styles.rowSublabel} numberOfLines={1}>
                  {selectedModelLabel}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </Pressable>
          </View>

          {(errorMessage ?? loadErrorMessage) ? (
            <Text style={styles.error}>{errorMessage ?? loadErrorMessage}</Text>
          ) : null}
        </ScrollView>
      )}

      <BottomDrawer visible={modelDrawerOpen} onClose={() => setModelDrawerOpen(false)}>
        <Text style={styles.drawerTitle}>
          {t('settings.voiceSettingsScreen.speechModel', 'Speech Model')}
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
