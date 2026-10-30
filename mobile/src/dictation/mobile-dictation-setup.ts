import { hostDictationErrorMessage } from '../../../src/shared/host-dictation-error-messages'
import { translate } from '../i18n/mobile-i18n'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RpcResponse } from '../transport/types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  dictationConfigWrite,
  dictationModelDelete,
  dictationModelDownload,
  dictationSetupRead
} from './mobile-dictation-operations'
import type { MobileSpeechModelReply, MobileSpeechSetupReply } from './dictation-reply-schema'

// Expose the reader’s salvaged shape; guarded members need not satisfy the host’s full setup type.
export type MobileSpeechSetup = MobileSpeechSetupReply
export type MobileSpeechModel = MobileSpeechModelReply

// Map setup errors to the setup sheet instead of leaving the mic entry point at a toast.
const SETUP_REQUIRED_CODES = new Set(['voice_dictation_disabled', 'voice_model_not_selected'])

// Older runtimes predate models.list; show upgrade guidance. Keep the raw refusal because guidance needs both code and message.
function isLegacyDesktopSpeechSetupReply(reply: RpcResponse): boolean {
  if (reply.ok) {
    return false
  }
  const message = reply.error?.message ?? ''
  return (
    message.includes('speech.models.list') &&
    (reply.error?.code === 'method_not_found' ||
      message.includes('not available to mobile clients'))
  )
}

// Headless servers lacked speech from 1.4.229 until #31174; name the required fix.
function speechlessServerMessage(): string {
  return translate(
    'dictation.setup.serverUpdateRequired',
    'Update Orca on this server to use voice dictation.'
  )
}

function isSpeechlessServerError(message: string): boolean {
  return message.startsWith('speech_unavailable')
}

export function dictationFailureMessage(message: string): string {
  if (isSpeechlessServerError(message)) {
    return speechlessServerMessage()
  }
  const fallback = hostDictationErrorMessage(message)
  if (fallback === undefined) {
    return message
  }
  switch (message) {
    case 'dictation_already_active':
      return translate('dictation.setup.alreadyActive', fallback)
    case 'dictation_requires_mobile_client':
      return translate('dictation.setup.repairRequired', fallback)
    case 'dictation_owner_mismatch':
    case 'dictation_stream_not_started':
    case 'dictation_stream_closing':
      return translate('dictation.setup.sessionLost', fallback)
    default:
      return fallback
  }
}

export function dictationSessionErrorMessage(
  kind: 'permission-denied' | 'unavailable' | 'no-speech' | 'interrupted' | 'input-closed'
): string {
  switch (kind) {
    case 'permission-denied':
      return translate(
        'hooks.useMobileDictation.microphonePermissionDenied',
        'Microphone permission denied'
      )
    case 'unavailable':
      return translate(
        'hooks.useMobileDictation.microphoneInitFailed',
        'Failed to initialize microphone'
      )
    case 'no-speech':
      return translate('hooks.useMobileDictation.noSpeech', 'No speech detected.')
    case 'interrupted':
      return translate(
        'hooks.useMobileDictation.microphoneInterrupted',
        'Voice dictation stopped because the microphone was interrupted. Try again.'
      )
    case 'input-closed':
      return translate(
        'hooks.useMobileDictation.inputClosed',
        'Voice dictation stopped because this session is no longer accepting input. Try again.'
      )
  }
}

function isSpeechlessServerReply(reply: RpcResponse): boolean {
  return !reply.ok && isSpeechlessServerError(reply.error?.message ?? '')
}

export function isDictationSetupRequiredError(message: string): boolean {
  return SETUP_REQUIRED_CODES.has(message) || message.startsWith('voice_model_not_ready:')
}

export async function fetchDictationSetup(client: RpcOperationSender): Promise<MobileSpeechSetup> {
  const reply = await requestDictationSetupReply(client)
  if (isLegacyDesktopSpeechSetupReply(reply)) {
    throw new Error(
      translate(
        'dictation.setup.desktopUpdateRequired',
        'Update the paired desktop Orca app to use mobile voice settings.'
      )
    )
  }
  if (isSpeechlessServerReply(reply)) {
    throw new Error(speechlessServerMessage())
  }
  return interpretOrThrowRefusalMessage(
    () => dictationSetupRead.interpret(reply),
    translate('dictation.setup.loadFailed', 'Failed to load dictation models')
  )
}

async function requestDictationSetupReply(client: RpcOperationSender): Promise<RpcResponse> {
  try {
    return await dictationSetupRead.request(client, null)
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      throw error
    }
    // Replay this read on authenticated replacement; mutations must surface cutover to avoid replaying unknown commits.
    return dictationSetupRead.request(client, null)
  }
}

export async function downloadDictationModel(
  client: RpcOperationSender,
  modelId: string
): Promise<void> {
  const reply = await dictationModelDownload.request(client, { modelId })
  interpretOrThrowRefusalMessage(
    () => dictationModelDownload.interpret(reply),
    translate('dictation.setup.downloadFailed', 'Failed to start download')
  )
}

export async function deleteDictationModel(
  client: RpcOperationSender,
  modelId: string
): Promise<MobileSpeechSetup> {
  const reply = await dictationModelDelete.request(client, { modelId })
  return interpretOrThrowRefusalMessage(
    () => dictationModelDelete.interpret(reply),
    translate('dictation.setup.deleteFailed', 'Failed to delete model')
  )
}

export async function setDictationConfig(
  client: RpcOperationSender,
  params: { enabled?: boolean; modelId?: string; dictationMode?: 'toggle' | 'hold' }
): Promise<MobileSpeechSetup> {
  const reply = await dictationConfigWrite.request(client, params)
  return interpretOrThrowRefusalMessage(
    () => dictationConfigWrite.interpret(reply),
    translate('dictation.setup.updateFailed', 'Failed to update dictation settings')
  )
}

export function isModelInFlight(model: MobileSpeechModel): boolean {
  return model.status === 'downloading' || model.status === 'extracting'
}

// Hide the mic only when dictation was turned off with a model chosen; with none chosen a tap explains setup.
export function dictationMicHidden(setup: MobileSpeechSetup): boolean {
  return setup.enabled === false && setup.selectedModelId !== ''
}

// Mirror the host's start refusals on what it reported; absent fields or an uncatalogued (user) model stay the host's call.
export function dictationNeedsSetup(setup: MobileSpeechSetup): boolean {
  if (setup.enabled === false || setup.selectedModelId === '') {
    return true
  }
  const status = setup.models.find((m) => m.id === setup.selectedModelId)?.status
  return status !== undefined && status !== 'ready'
}

// Keep copy short and host-neutral: the paired computer may be a headless server.
export function cloudModelNeedsKey(): string {
  return translate('dictation.setup.cloudModelNeedsKey', 'Needs an OpenAI key')
}

export type DictationModelRowAction =
  | 'in-use'
  | 'use'
  | 'download'
  | 'downloading'
  | 'needs-api-key'

// Windows and managed SSH hosts may offer only cloud models; those rows must remain selectable.
export function dictationModelRowAction(
  model: MobileSpeechModel,
  selectedModelId: string | undefined
): DictationModelRowAction {
  if (model.status === 'ready') {
    return model.id === selectedModelId ? 'in-use' : 'use'
  }
  if (model.provider === 'openai') {
    return 'needs-api-key'
  }
  return isModelInFlight(model) ? 'downloading' : 'download'
}
