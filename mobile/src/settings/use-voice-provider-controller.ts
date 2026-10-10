import { useCallback, useState } from 'react'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { useDictationSetupPoller } from '../dictation/use-dictation-setup-poller'
import { hasSpeechModelInFlight } from '../dictation/speech-provider-presentation'
import { SPEECH_PROVIDERS_UNAVAILABLE_MESSAGE } from '../dictation/mobile-speech-providers'
import type {
  MobileSpeechProviderKeyTest,
  MobileSpeechProvidersState
} from '../dictation/speech-provider-reply-schema'
import type { SpeechModelBusy } from './speech-model-picker-drawer'
import { useVoiceRequestFence } from './use-voice-request-fence'
import { useVoiceScopedErrors } from './use-voice-scoped-errors'

const POLL_INTERVAL_MS = 1500

export type ProviderKeyAction = 'saving' | 'testing' | 'removing'

function errorText(err: unknown, fallback: string): string {
  return (err instanceof Error ? err.message : '') || fallback
}

/** State and actions for one provider's screen: key lifecycle plus that provider's models. */
export function useVoiceProviderController(
  operations: VoiceSettingsOperations | null,
  focused: boolean
) {
  const [state, setState] = useState<MobileSpeechProvidersState | null>(null)
  const [loading, setLoading] = useState(true)
  const { error, errors, setScopeError, clearErrors } = useVoiceScopedErrors()
  const [busyAction, setBusyAction] = useState<SpeechModelBusy | null>(null)
  // Why: an object per request so only the request that started the spinner can end it.
  const [keyActionRun, setKeyActionRun] = useState<{ action: ProviderKeyAction } | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<MobileSpeechProviderKeyTest | null>(null)
  const [keyDrawerOpen, setKeyDrawerOpen] = useState(false)
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  const providerOps = operations?.providers ?? null
  const fence = useVoiceRequestFence(operations)
  const [stateOperations, setStateOperations] = useState(operations)
  // Why: a disconnect (null) keeps the last desktop's state on screen; only a different client resets it.
  if (operations && stateOperations !== operations) {
    // Why: key and model actions now go to the new desktop, so the old one's state must not linger.
    setStateOperations(operations)
    setState(null)
    setLoading(true)
    clearErrors()
    setBusyAction(null)
    setKeyActionRun(null)
    setKeyError(null)
    setTestResult(null)
    setKeyDrawerOpen(false)
    setConfirmRemoveOpen(false)
  }
  const startKeyAction = useCallback((action: ProviderKeyAction) => {
    const run = { action }
    setKeyActionRun(run)
    return run
  }, [])
  const endKeyAction = useCallback((run: { action: ProviderKeyAction }) => {
    setKeyActionRun((prev) => (prev === run ? null : prev))
  }, [])

  const refresh = useCallback(async (): Promise<boolean | undefined> => {
    if (!providerOps) {
      return false
    }
    const ticket = fence.peek()
    setLoading(true)
    try {
      const next = await providerOps.list()
      if (!fence.isLatest(ticket)) {
        return undefined
      }
      if (!next) {
        setScopeError('read', SPEECH_PROVIDERS_UNAVAILABLE_MESSAGE)
        return false
      }
      setState(next)
      setScopeError('read', null)
      return hasSpeechModelInFlight(next)
    } catch (err) {
      if (fence.isLatest(ticket)) {
        setScopeError('read', errorText(err, 'Failed to load speech providers'))
      }
      return undefined
    } finally {
      if (fence.isSameHost(ticket)) {
        setLoading(false)
      }
    }
  }, [fence, providerOps, setScopeError])

  const refreshNow = useDictationSetupPoller({
    visible: focused && providerOps !== null,
    polling: state ? hasSpeechModelInFlight(state) : false,
    refresh,
    intervalMs: POLL_INTERVAL_MS
  })

  const saveKey = useCallback(
    async (providerId: string, apiKey: string) => {
      if (!providerOps) {
        return
      }
      const ticket = fence.begin('key')
      const keyRun = startKeyAction('saving')
      setKeyError(null)
      // Why: a newer key change supersedes an earlier removal failure for this provider.
      setScopeError('key', null)
      try {
        const next = await providerOps.saveKey(providerId, apiKey)
        if (fence.claimSnapshot(ticket, refreshNow)) {
          setState(next)
          setScopeError('read', null)
        }
        if (!fence.isLatestInScope(ticket)) {
          return
        }
        setKeyDrawerOpen(false)
        // Why: the host verified the key before saving, so the connection is known good.
        setTestResult({ ok: true, message: null })
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setKeyError(errorText(err, 'Could not save the API key'))
        }
      } finally {
        endKeyAction(keyRun)
      }
    },
    [endKeyAction, fence, providerOps, refreshNow, setScopeError, startKeyAction]
  )

  const testKey = useCallback(
    async (providerId: string) => {
      if (!providerOps) {
        return
      }
      // Why: a save or remove after this test started makes its verdict about a key that is gone.
      const ticket = fence.peek('key')
      const keyRun = startKeyAction('testing')
      setTestResult(null)
      let result: MobileSpeechProviderKeyTest
      try {
        result = await providerOps.testKey(providerId)
      } catch (err) {
        result = { ok: false, message: errorText(err, 'Could not test the API key') }
      } finally {
        endKeyAction(keyRun)
      }
      if (fence.isLatestInScope(ticket)) {
        setTestResult(result)
      }
    },
    [endKeyAction, fence, providerOps, startKeyAction]
  )

  const removeKey = useCallback(
    async (providerId: string) => {
      if (!providerOps) {
        return
      }
      const ticket = fence.begin('key')
      const keyRun = startKeyAction('removing')
      setScopeError('key', null)
      setTestResult(null)
      try {
        const next = await providerOps.clearKey(providerId)
        if (fence.claimSnapshot(ticket, refreshNow)) {
          setState(next)
          setScopeError('read', null)
        }
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError('key', errorText(err, 'Could not remove the API key'))
        }
      } finally {
        endKeyAction(keyRun)
      }
    },
    [endKeyAction, fence, providerOps, refreshNow, setScopeError, startKeyAction]
  )

  const runModelAction = useCallback(
    async (busy: SpeechModelBusy, action: () => Promise<unknown>, fallback: string) => {
      // Why: selecting is a config write; download/delete change model files, so neither hides the other.
      const scope = busy.type === 'select' ? 'config' : 'model'
      const ticket = fence.begin(scope)
      setBusyAction(busy)
      setScopeError(scope, null)
      try {
        await action()
        await refreshNow()
      } catch (err) {
        if (fence.isLatestInScope(ticket)) {
          setScopeError(scope, errorText(err, fallback))
        }
      } finally {
        setBusyAction((prev) => (prev === busy ? null : prev))
      }
    },
    [fence, refreshNow, setScopeError]
  )

  const selectModel = useCallback(
    (modelId: string) =>
      operations
        ? runModelAction(
            { modelId, type: 'select' },
            () => operations.configure({ enabled: true, modelId }),
            'Could not select model'
          )
        : undefined,
    [operations, runModelAction]
  )
  const downloadModel = useCallback(
    (modelId: string) =>
      operations
        ? runModelAction(
            { modelId, type: 'download' },
            () => operations.download(modelId),
            'Download failed'
          )
        : undefined,
    [operations, runModelAction]
  )
  const deleteModel = useCallback(
    (modelId: string) =>
      operations
        ? runModelAction(
            { modelId, type: 'delete' },
            () => operations.delete(modelId),
            'Delete failed'
          )
        : undefined,
    [operations, runModelAction]
  )

  const openKeyDrawer = useCallback(() => {
    setKeyError(null)
    setKeyDrawerOpen(true)
  }, [])

  return {
    state,
    loading,
    error,
    errors,
    busyAction,
    keyAction: keyActionRun?.action ?? null,
    keyError,
    setKeyError,
    testResult,
    keyDrawerOpen,
    setKeyDrawerOpen,
    openKeyDrawer,
    confirmRemoveOpen,
    setConfirmRemoveOpen,
    saveKey,
    testKey,
    removeKey,
    selectModel,
    downloadModel,
    deleteModel
  }
}
