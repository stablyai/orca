import type { RuntimeSpeechSetupState } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

export type MobileSpeechSetup = RuntimeSpeechSetupState
export type MobileSpeechModel = RuntimeSpeechSetupState['models'][number]

// Dictation-setup errors startMobileDictation throws when the desktop isn't
// configured. Mapping them lets the mic entry point open the setup sheet
// instead of dead-ending on a toast.
const SETUP_REQUIRED_CODES = new Set(['voice_dictation_disabled', 'voice_model_not_selected'])
const LEGACY_DESKTOP_SPEECH_SETUP_MESSAGE =
  'Update the paired desktop Orca app to use mobile voice settings.'

// Why: mobile can pair with older desktop runtimes that predate speech.models.list;
// show upgrade guidance instead of leaking the raw denial or not-found error.
function isLegacyDesktopSpeechSetupError(
  error: { code?: string; message?: string } | undefined
): boolean {
  const message = error?.message ?? ''
  return (
    message.includes('speech.models.list') &&
    (error?.code === 'method_not_found' || message.includes('not available to mobile clients'))
  )
}

export function isDictationSetupRequiredError(message: string): boolean {
  return SETUP_REQUIRED_CODES.has(message) || message.startsWith('voice_model_not_ready:')
}

export async function fetchDictationSetup(
  client: Pick<RpcClient, 'sendRequest'>
): Promise<MobileSpeechSetup> {
  const response = await client.sendRequest('speech.models.list', null)
  if (!response.ok) {
    if (isLegacyDesktopSpeechSetupError(response.error)) {
      throw new Error(LEGACY_DESKTOP_SPEECH_SETUP_MESSAGE)
    }
    throw new Error(response.error?.message || 'Failed to load dictation models')
  }
  return (response as RpcSuccess).result as MobileSpeechSetup
}

export async function downloadDictationModel(
  client: Pick<RpcClient, 'sendRequest'>,
  modelId: string
): Promise<void> {
  const response = await client.sendRequest('speech.models.download', { modelId })
  if (!response.ok) {
    throw new Error(response.error?.message || 'Failed to start download')
  }
}

export async function setDictationConfig(
  client: Pick<RpcClient, 'sendRequest'>,
  params: { enabled?: boolean; modelId?: string; dictationMode?: 'toggle' | 'hold' }
): Promise<MobileSpeechSetup> {
  const response = await client.sendRequest('speech.dictation.setup', params)
  if (!response.ok) {
    throw new Error(response.error?.message || 'Failed to update dictation settings')
  }
  return (response as RpcSuccess).result as MobileSpeechSetup
}

// A model is mid-download (or extracting) and the sheet should keep polling.
export function isModelInFlight(model: MobileSpeechModel): boolean {
  return model.status === 'downloading' || model.status === 'extracting'
}

// Whether dictation can be used right now: enabled + a selected model that's ready.
export function isDictationReady(setup: MobileSpeechSetup): boolean {
  if (!setup.enabled || !setup.selectedModelId) {
    return false
  }
  const selected = setup.models.find((m) => m.id === setup.selectedModelId)
  return selected?.status === 'ready'
}
