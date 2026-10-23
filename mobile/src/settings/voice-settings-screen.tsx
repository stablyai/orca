import { useCallback, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Mic, MonitorOff, TriangleAlert } from 'lucide-react-native'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import { PickerSheetTitle } from '../components/PickerModal'
import { ListRow } from '../components/ui/ListRow'
import { Banner } from '../components/ui/Banner'
import { StateView } from '../components/ui/StateView'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { VoiceModelList } from '../components/VoiceModelList'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'
import { SettingsScreen, SettingsSection, SettingsSwitchRow } from './settings-screen-frame'

const POLL_INTERVAL_MS = 1500

const DICTATION_MODES = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Hold' }
] as const

const MODE_HINT = {
  toggle: 'Press once to start, again to stop.',
  hold: 'Dictate only while held.'
} as const

const NO_DESKTOP: VoiceSettingsConnection = { kind: 'no-desktop' }

type ModelBusyAction = { modelId: string; type: 'download' | 'select' | 'delete' }

/** Why there is no desktop to talk to yet, named so the screen can say which and offer a way on. */
export type VoiceSettingsConnection =
  | { kind: 'no-desktop' }
  | { kind: 'connecting'; desktopName?: string }
  | { kind: 'offline'; desktopName?: string; onRetry?: () => void }

export default function VoiceSettingsScreen({
  operations,
  focused,
  onBack,
  connection = NO_DESKTOP
}: {
  operations: VoiceSettingsOperations | null
  focused: boolean
  onBack: () => void
  /** Read only while `operations` is null. */
  connection?: VoiceSettingsConnection
}): React.JSX.Element {
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<ModelBusyAction | null>(null)
  const requestEpoch = useRef(0)
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!operations) {
      return false
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
      setError(err instanceof Error ? err.message : 'Failed to load voice settings')
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
      requestEpoch.current += 1
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
        setSetup(await operations.configure(params))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update')
        void refreshSetup()
      }
    },
    [operations, refreshSetup]
  )

  const handleUseModel = useCallback(
    async (model: MobileSpeechModel) => {
      if (!operations) {
        return
      }
      requestEpoch.current += 1
      setBusyAction({ modelId: model.id, type: 'select' })
      setError(null)
      try {
        setSetup(await operations.configure({ enabled: true, modelId: model.id }))
        setModelDrawerOpen(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not select model')
      } finally {
        setBusyAction(null)
      }
    },
    [operations]
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
        setError(err instanceof Error ? err.message : 'Download failed')
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
      requestEpoch.current += 1
      setBusyAction({ modelId: model.id, type: 'delete' })
      setError(null)
      try {
        setSetup(await operations.delete(model.id))
        if (deletedSelectedModel) {
          setModelDrawerOpen(false)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed')
      } finally {
        setBusyAction(null)
      }
    },
    [operations, setup?.selectedModelId]
  )

  const enabled = setup?.enabled ?? false
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel = selectedModel?.label ?? 'None selected'

  return (
    <SettingsScreen title="Voice" onBack={onBack}>
      {!operations ? (
        <VoiceConnectionState connection={connection} />
      ) : loading && setup === null ? (
        <View style={styles.state}>
          <StateView loading title="Loading voice settings…" />
        </View>
      ) : setup === null ? (
        <View style={styles.state}>
          <StateView
            icon={TriangleAlert}
            title="Couldn't load voice settings"
            message={error ?? 'Failed to load voice settings.'}
            primary={{ label: 'Retry', onPress: () => void refreshSetup() }}
          />
        </View>
      ) : (
        <>
          <SettingsSection title="Dictation" first>
            <SettingsSwitchRow
              testID="voice-enabled"
              title="Voice dictation"
              subtitle="Dictate into the focused pane on your desktop."
              accessibilityLabel="Enable voice dictation"
              value={enabled}
              onValueChange={(next) => void configure({ enabled: next })}
            />
            <View style={styles.modeRow}>
              <Text style={[styles.modeLabel, !enabled && styles.dimmed]}>Mode</Text>
              <MobileSegmentedControl
                segments={DICTATION_MODES}
                selected={setup.dictationMode}
                onSelect={(dictationMode) => void configure({ dictationMode })}
                testIDPrefix="voice-mode-"
                disabled={!enabled}
                fill
              />
              <Text style={[styles.modeHint, !enabled && styles.dimmed]}>
                {setup.dictationMode === 'hold' ? MODE_HINT.hold : MODE_HINT.toggle}
              </Text>
            </View>
          </SettingsSection>

          <SettingsSection title="Speech model">
            <ListRow
              title="Model"
              value={selectedModelLabel}
              navigates
              disabled={!enabled}
              testID="voice-model-picker"
              accessibilityLabel={`Speech model, ${selectedModelLabel}`}
              onPress={() => setModelDrawerOpen(true)}
            />
          </SettingsSection>

          {error ? (
            <View style={styles.banner}>
              <Banner tone="error" message={error} onDismiss={() => setError(null)} />
            </View>
          ) : null}
        </>
      )}

      <BottomDrawer visible={modelDrawerOpen} onClose={() => setModelDrawerOpen(false)}>
        <PickerSheetTitle title="Speech model" />
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
    </SettingsScreen>
  )
}

function VoiceConnectionState({ connection }: { connection: VoiceSettingsConnection }) {
  if (connection.kind === 'connecting') {
    return (
      <View style={styles.state}>
        <StateView
          loading
          title={
            connection.desktopName
              ? `Connecting to ${connection.desktopName}…`
              : 'Connecting to your desktop…'
          }
        />
      </View>
    )
  }
  if (connection.kind === 'offline') {
    return (
      <View style={styles.state}>
        <StateView
          icon={MonitorOff}
          title={
            connection.desktopName ? `${connection.desktopName} is offline` : 'Desktop is offline'
          }
          message="Voice settings live on your desktop. Open Orca there, then retry."
          primary={connection.onRetry ? { label: 'Retry', onPress: connection.onRetry } : undefined}
        />
      </View>
    )
  }
  return (
    <View style={styles.state}>
      <StateView
        icon={Mic}
        title="No desktop paired"
        message="Pair a desktop to manage voice dictation."
      />
    </View>
  )
}

const styles = StyleSheet.create({
  state: { minHeight: 360 },
  modeRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md + 2,
    gap: spacing.sm
  },
  dimmed: { opacity: 0.5 },
  modeLabel: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  modeHint: { ...textStyles.subhead, color: colors.textSecondary },
  banner: { marginTop: spacing.lg }
})
