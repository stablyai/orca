import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { PickerModal } from '../components/sheets/PickerModal'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListRow } from '../components/list/ListGroup'
import { VoiceModelList } from '../dictation/setup/VoiceModelList'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import {
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import {
  dictationShortcutMode,
  dictationShortcutModeSettings
} from '../../../src/shared/speech/dictation/dictation-shortcut-mode'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'
import { VoiceTranscribeOnSection } from './voice-transcribe-on-section'
import { dictationModes, isDictationShortcutMode } from './voice-dictation-modes'

const POLL_INTERVAL_MS = 1500

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
  hostName,
  connecting = false,
  focused,
  onBack
}: {
  operations: VoiceSettingsOperations | null
  /** The computer whose dictation this edits; shown so it's never changed silently. */
  hostName?: string
  /** A paired desktop is still dialing, so the screen is loading rather than unpaired. */
  connecting?: boolean
  focused: boolean
  onBack: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
  const [modePickerOpen, setModePickerOpen] = useState(false)
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
      const { enabled, dictationMode, dictationHoldToRecord } = params
      setSetup((prev) =>
        prev
          ? {
              ...prev,
              ...(enabled === undefined ? {} : { enabled }),
              ...(dictationMode === undefined ? {} : { dictationMode }),
              ...(dictationHoldToRecord === undefined || prev.dictationHoldToRecord === undefined
                ? {}
                : { dictationHoldToRecord })
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
  const offersAuto = setup?.dictationHoldToRecord !== undefined
  const selectedModel = setup?.models.find((m) => m.id === setup.selectedModelId)
  const selectedModelLabel =
    selectedModel?.label ?? t('settings.voiceSettingsScreen.noneSelected', 'None selected')
  const loadErrorMessage = voiceSettingsErrorMessage(t, loadError)
  const errorMessage = voiceSettingsErrorMessage(t, error)

  const showLoading = operations ? loading && setup === null : connecting
  const footerError = errorMessage ?? loadErrorMessage

  const modes = dictationModes(t, offersAuto)
  const mode = setup ? (offersAuto ? dictationShortcutMode(setup) : setup.dictationMode) : undefined
  const dictationTitle = t('settings.voiceSettingsScreen.dictation', 'Dictation')

  return (
    <SettingsScreen
      title={t('settings.voiceSettingsScreen.title', 'Voice')}
      onBack={onBack}
      fillContent={showLoading}
      overlays={
        <>
          <PickerModal
            visible={modePickerOpen}
            title={t('settings.voiceSettingsScreen.mode', 'Mode')}
            subtitle={hostName}
            options={modes}
            selected={mode ?? ''}
            onSelect={(next) => {
              if (isDictationShortcutMode(next)) {
                void configure(dictationShortcutModeSettings(next))
              }
            }}
            onClose={() => setModePickerOpen(false)}
          />
          <BottomDrawer visible={modelDrawerOpen} onClose={() => setModelDrawerOpen(false)}>
            <SheetHeader
              title={t('settings.voiceSettingsScreen.model', 'Model')}
              subtitle={hostName}
              onClose={() => setModelDrawerOpen(false)}
            />
            {setup ? (
              <View style={styles.models}>
                <VoiceModelList
                  setup={setup}
                  disabled={false}
                  busyAction={busyAction}
                  onUseModel={(m) => void handleUseModel(m)}
                  onDownload={(m) => void handleDownload(m)}
                  onDelete={(m) => void handleDelete(m)}
                />
                <SettingsNote>
                  {t(
                    'settings.voiceSettingsScreen.swipeToDelete',
                    'Swipe a downloaded model left to delete it.'
                  )}
                </SettingsNote>
              </View>
            ) : null}
          </BottomDrawer>
        </>
      }
    >
      {showLoading ? (
        <MobileStateView
          loading
          title={t('settings.voiceSettingsScreen.loading', 'Loading voice settings…')}
        />
      ) : !operations ? (
        <SettingsNote>
          {t(
            'settings.voiceSettingsScreen.connectDesktop',
            'Connect to a desktop to manage voice settings.'
          )}
        </SettingsNote>
      ) : setup === null ? (
        <SettingsNote error>
          {loadErrorMessage ??
            t('settings.voiceSettingsScreen.loadFailedMessage', 'Failed to load voice settings.')}
        </SettingsNote>
      ) : (
        <>
          <SettingsSection
            first
            footer={
              enabled
                ? undefined
                : t(
                    'settings.voiceSettingsScreen.dictationOffFooter',
                    'Talk instead of typing in chats and terminals.'
                  )
            }
          >
            <ListRow
              key="enabled"
              title={dictationTitle}
              subtitle={
                hostName
                  ? t('settings.voiceSettingsScreen.runsOn', 'Runs on {{name}}', {
                      name: hostName
                    })
                  : undefined
              }
              accessory={
                <MobileSwitch
                  testID="voice-enabled"
                  accessibilityLabel={dictationTitle}
                  value={enabled}
                  onValueChange={(enabled) => void configure({ enabled })}
                />
              }
            />
          </SettingsSection>

          {enabled ? (
            <SettingsSection
              footer={footerError ? <SettingsNote error>{footerError}</SettingsNote> : undefined}
            >
              <ListRow
                key="mode"
                title={t('settings.voiceSettingsScreen.mode', 'Mode')}
                value={modes.find((option) => option.value === mode)?.label}
                navigates
                testID="voice-mode"
                onPress={() => setModePickerOpen(true)}
              />
              <ListRow
                key="model"
                title={t('settings.voiceSettingsScreen.model', 'Model')}
                value={selectedModelLabel}
                navigates
                testID="voice-model-picker"
                onPress={() => setModelDrawerOpen(true)}
              />
            </SettingsSection>
          ) : footerError ? (
            <SettingsNote error>{footerError}</SettingsNote>
          ) : null}
        </>
      )}
      <VoiceTranscribeOnSection />
    </SettingsScreen>
  )
}

const styles = themedStyleSheet(() => ({
  models: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }
}))
