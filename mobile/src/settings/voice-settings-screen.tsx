import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { voiceSettingsStyles as styles } from './voice-settings-styles'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { VoiceModelList } from '../components/VoiceModelList'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'

const POLL_INTERVAL_MS = 1500

const DICTATION_MODES = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Hold' }
] as const

type ModelBusyAction = { modelId: string; type: 'download' | 'select' | 'delete' }

type VoiceSettingsScreenProps = {
  operations: VoiceSettingsOperations | null
  focused: boolean
  onBack: () => void
}

export default function VoiceSettingsScreen(props: VoiceSettingsScreenProps): React.JSX.Element {
  const [runtime, setRuntime] = useState({ operations: props.operations, revision: 0 })
  if (runtime.operations !== props.operations) {
    setRuntime({ operations: props.operations, revision: runtime.revision + 1 })
  }
  return <VoiceSettingsScreenContent key={runtime.revision} {...props} />
}

function VoiceSettingsScreenContent({
  operations,
  focused,
  onBack
}: VoiceSettingsScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<ModelBusyAction | null>(null)
  const requestEpoch = useRef(0)
  const mutationQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingMutations = useRef(0)
  const runMutation = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    pendingMutations.current += 1
    const result = mutationQueue.current.then(action)
    mutationQueue.current = result.then(
      () => undefined,
      () => undefined
    )
    return result.finally(() => {
      pendingMutations.current -= 1
    })
  }, [])
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!operations) {
      return false
    }
    if (pendingMutations.current > 0) {
      return undefined
    }
    const epoch = requestEpoch.current
    // Own the spinner from the read that clears it, so a retry after a failed load shows
    // the spinner again instead of the stale error card. Reads are serialised by
    // DictationSetupPollController, so no in-flight read can clear another's flag.
    setLoading(true)
    try {
      const next = await operations.load()
      if (epoch !== requestEpoch.current) {
        return undefined
      }
      setSetup(next)
      setError(null)
      return next.models.some(isModelInFlight)
    } catch (err) {
      if (epoch === requestEpoch.current && pendingMutations.current === 0) {
        setError(err instanceof Error ? err.message : 'Failed to load voice settings')
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

  const configure = useCallback(
    async (params: Parameters<VoiceSettingsOperations['configure']>[0]) => {
      if (!operations) {
        return
      }
      const epoch = ++requestEpoch.current
      setError(null)
      // Optimistic flip so the control responds instantly; reconcile below.
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
      try {
        const next = await runMutation(() => operations.configure(params))
        if (epoch === requestEpoch.current) {
          setSetup(next)
        }
      } catch (err) {
        if (epoch === requestEpoch.current) {
          setError(err instanceof Error ? err.message : 'Could not update')
          void refreshSetup()
        }
      }
    },
    [operations, refreshSetup, runMutation]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      const epoch = ++requestEpoch.current
      setBusyAction({ modelId: model.id, type: 'select' })
      setError(null)
      try {
        const next = await runMutation(() =>
          operations.configure({ enabled: true, modelId: model.id })
        )
        if (epoch === requestEpoch.current) {
          setSetup(next)
          setModelDrawerOpen(false)
        }
      } catch (err) {
        if (epoch === requestEpoch.current) {
          setError(err instanceof Error ? err.message : 'Could not select model')
        }
      } finally {
        setBusyAction(null)
      }
    },
    [operations, runMutation]
  )

  const handleDownload = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      const epoch = ++requestEpoch.current
      setBusyAction({ modelId: model.id, type: 'download' })
      setError(null)
      try {
        await runMutation(() => operations.download(model.id))
        if (epoch === requestEpoch.current) {
          await refreshSetup()
        }
      } catch (err) {
        if (epoch === requestEpoch.current) {
          setError(err instanceof Error ? err.message : 'Download failed')
        }
      } finally {
        setBusyAction(null)
      }
    },
    [operations, refreshSetup, runMutation]
  )

  const handleDelete = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      const deletedSelectedModel = setup?.selectedModelId === model.id
      const epoch = ++requestEpoch.current
      setBusyAction({ modelId: model.id, type: 'delete' })
      setError(null)
      try {
        const next = await runMutation(() => operations.delete(model.id))
        if (epoch === requestEpoch.current) {
          setSetup(next)
          if (deletedSelectedModel) {
            setModelDrawerOpen(false)
          }
        }
      } catch (err) {
        if (epoch === requestEpoch.current) {
          setError(err instanceof Error ? err.message : 'Delete failed')
        }
      } finally {
        setBusyAction(null)
      }
    },
    [operations, runMutation, setup?.selectedModelId]
  )

  const enabled = setup?.enabled ?? false
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel = selectedModel?.label ?? 'None selected'

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Voice</Text>
      </View>

      {!operations ? (
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
                testID="voice-enabled"
                accessibilityLabel="Enable Voice Dictation"
                value={enabled}
                onValueChange={(enabled) => void configure({ enabled })}
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
              <MobileSegmentedControl
                segments={DICTATION_MODES}
                selected={setup.dictationMode}
                onSelect={(dictationMode) => void configure({ dictationMode })}
                testIDPrefix="voice-mode-"
              />
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
              testID="voice-model-picker"
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
