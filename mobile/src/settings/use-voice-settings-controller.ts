import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import { isModelInFlight, type MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import { hasSpeechModelInFlight } from '../dictation/speech-provider-presentation'
import type { MobileSpeechProvidersState } from '../dictation/speech-provider-reply-schema'
import type { SpeechModelBusy } from './speech-model-picker-drawer'
import { useVoiceRequestFence } from './use-voice-request-fence'
import { useVoiceScopedErrors } from './use-voice-scoped-errors'

const POLL_INTERVAL_MS = 1500

type ConfigureParams = Parameters<VoiceSettingsOperations['configure']>[0]

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/** `speech.dictation.setup` answers with the legacy setup; fold its scalar members into the cabinet. */
function mergeSetupIntoCabinet(
  cabinet: MobileSpeechProvidersState | null,
  setup: MobileSpeechSetup
): MobileSpeechProvidersState | null {
  if (!cabinet) {
    return cabinet
  }
  return {
    ...cabinet,
    enabled: setup.enabled ?? cabinet.enabled,
    dictationMode: setup.dictationMode ?? cabinet.dictationMode,
    selectedModelId: setup.selectedModelId ?? cabinet.selectedModelId
  }
}

/** Voice screen state: provider `cabinet` on newer desktops, legacy `setup` on older ones. */
export function useVoiceSettingsController(
  operations: VoiceSettingsOperations | null,
  focused: boolean
) {
  const [setup, setSetup] = useState<MobileSpeechSetup | null>(null)
  const [cabinet, setCabinet] = useState<MobileSpeechProvidersState | null>(null)
  const [loading, setLoading] = useState(true)
  const { error, errors, setScopeError, clearErrors } = useVoiceScopedErrors()
  const [busyAction, setBusyAction] = useState<SpeechModelBusy | null>(null)
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const [languageDrawerOpen, setLanguageDrawerOpen] = useState(false)
  const fence = useVoiceRequestFence(operations)
  // Why: null = not probed yet; false sticks so polling an old desktop doesn't re-probe each tick.
  const cabinetSupported = useRef<boolean | null>(null)
  const [stateOperations, setStateOperations] = useState(operations)
  // Why: a disconnect (null) keeps the last desktop's state on screen; only a different client resets it.
  if (operations && stateOperations !== operations) {
    // Why: actions now go to the new desktop, so the old one's models must not stay actionable.
    setStateOperations(operations)
    setSetup(null)
    setCabinet(null)
    setLoading(true)
    clearErrors()
    setBusyAction(null)
    setModelDrawerOpen(false)
    setLanguageDrawerOpen(false)
  }

  // Why: a new client may be an older desktop, so it must be probed before the next read.
  useLayoutEffect(() => {
    cabinetSupported.current = null
  }, [operations])

  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!operations) {
      return false
    }
    const ticket = fence.peek()
    // Why: owning the spinner shows it again on retry; the poller serialises reads per desktop.
    setLoading(true)
    try {
      const providerOps = operations.providers
      if (providerOps && cabinetSupported.current !== false) {
        const next = await providerOps.list()
        if (!fence.isLatest(ticket)) {
          return undefined
        }
        if (next) {
          cabinetSupported.current = true
          setCabinet(next)
          setScopeError('read', null)
          return hasSpeechModelInFlight(next)
        }
        cabinetSupported.current = false
        setCabinet(null)
      }
      const next = await operations.load()
      if (!fence.isLatest(ticket)) {
        return undefined
      }
      setSetup(next)
      setScopeError('read', null)
      return next.models.some(isModelInFlight)
    } catch (err) {
      if (fence.isLatest(ticket)) {
        setScopeError('read', errorText(err, 'Failed to load voice settings'))
      }
      return undefined
    } finally {
      if (fence.isSameHost(ticket)) {
        setLoading(false)
      }
    }
  }, [fence, operations, setScopeError])

  const polling = cabinet
    ? hasSpeechModelInFlight(cabinet)
    : (setup?.models.some(isModelInFlight) ?? false)
  const refreshSetup = useDictationSetupPoller({
    visible: focused && operations !== null,
    polling,
    refresh,
    intervalMs: POLL_INTERVAL_MS
  })

  const applySetup = useCallback((next: MobileSpeechSetup) => {
    setSetup(next)
    setCabinet((prev) => mergeSetupIntoCabinet(prev, next))
  }, [])

  const configure = useCallback(
    async (params: ConfigureParams) => {
      if (!operations) {
        return
      }
      const ticket = fence.begin('config')
      setScopeError('config', null)
      // Optimistic flip so the control responds instantly; reconcile below.
      const { enabled, dictationMode } = params
      const flip = {
        ...(enabled === undefined ? {} : { enabled }),
        ...(dictationMode === undefined ? {} : { dictationMode })
      }
      setSetup((prev) => (prev ? { ...prev, ...flip } : prev))
      setCabinet((prev) => (prev ? { ...prev, ...flip } : prev))
      try {
        const next = await operations.configure(params)
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          applySetup(next)
          setScopeError('read', null)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('config', errorText(err, 'Could not update'))
          void refreshSetup()
        }
      }
    },
    [applySetup, fence, operations, refreshSetup, setScopeError]
  )

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!operations) {
        return
      }
      const ticket = fence.begin('config')
      const busy: SpeechModelBusy = { modelId, type: 'select' }
      setBusyAction(busy)
      setScopeError('config', null)
      try {
        const next = await operations.configure({ enabled: true, modelId })
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          applySetup(next)
          setScopeError('read', null)
        }
        if (fence.isLatestInScope(ticket)) {
          setModelDrawerOpen(false)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('config', errorText(err, 'Could not select model'))
        }
      } finally {
        setBusyAction((prev) => (prev === busy ? null : prev))
      }
    },
    [applySetup, fence, operations, refreshSetup, setScopeError]
  )

  const downloadModel = useCallback(
    async (modelId: string) => {
      if (!operations) {
        return
      }
      const ticket = fence.begin('model')
      const busy: SpeechModelBusy = { modelId, type: 'download' }
      setBusyAction(busy)
      setScopeError('model', null)
      try {
        await operations.download(modelId)
        await refreshSetup()
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('model', errorText(err, 'Download failed'))
        }
      } finally {
        setBusyAction((prev) => (prev === busy ? null : prev))
      }
    },
    [fence, operations, refreshSetup, setScopeError]
  )

  const deleteModel = useCallback(
    async (modelId: string) => {
      if (!operations) {
        return
      }
      // Why: the cabinet is authoritative on a newer desktop; the legacy setup on an older one.
      const deletedSelectedModel = (cabinet?.selectedModelId ?? setup?.selectedModelId) === modelId
      const ticket = fence.begin('model')
      const busy: SpeechModelBusy = { modelId, type: 'delete' }
      setBusyAction(busy)
      setScopeError('model', null)
      try {
        const next = await operations.delete(modelId)
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          applySetup(next)
          setScopeError('read', null)
        }
        if (deletedSelectedModel && fence.isLatestInScope(ticket)) {
          setModelDrawerOpen(false)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('model', errorText(err, 'Delete failed'))
        }
      } finally {
        setBusyAction((prev) => (prev === busy ? null : prev))
      }
    },
    [applySetup, cabinet?.selectedModelId, fence, operations, setScopeError, setup?.selectedModelId]
  )

  const setLanguage = useCallback(
    async (language: string) => {
      const providerOps = operations?.providers
      if (!providerOps) {
        return
      }
      const ticket = fence.begin('config')
      setLanguageDrawerOpen(false)
      setScopeError('config', null)
      setCabinet((prev) => (prev ? { ...prev, language } : prev))
      try {
        const next = await providerOps.setLanguage(language)
        if (fence.claimSnapshot(ticket, refreshSetup)) {
          setCabinet(next)
          setScopeError('read', null)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('config', errorText(err, 'Could not change the language'))
          void refreshSetup()
        }
      }
    },
    [fence, operations, refreshSetup, setScopeError]
  )

  return {
    setup,
    cabinet,
    loading,
    error,
    errors,
    busyAction,
    modelDrawerOpen,
    setModelDrawerOpen,
    languageDrawerOpen,
    setLanguageDrawerOpen,
    configure,
    selectModel,
    downloadModel,
    deleteModel,
    setLanguage
  }
}
