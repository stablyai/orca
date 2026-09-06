import type {
  MobileWebSpeechStartResult,
  MobileWebSpeechStopResult
} from '../../../src/shared/mobile-web/speech-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { DICTATION_FINISH_TIMEOUT_MS } from '../hooks/mobile-dictation-session-state'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export type MobileWebSpeechSession = {
  id: string
  client: RpcClient
  generation: number
  acceptingChunks: boolean
  remoteCancelSent: boolean
}

export async function startMobileWebRemoteSpeechSession(
  client: RpcClient,
  dictationId: string
): Promise<MobileWebSpeechStartResult | null> {
  const response = await client.sendRequest('speech.dictation.start', { dictationId }).catch(() => {
    throw new MobileWebBrokerError('host_error')
  })
  if (response.ok) {
    return null
  }
  const setupResult = setupRequiredResult(response.error.message)
  if (setupResult) {
    return setupResult
  }
  throw new MobileWebBrokerError('host_error')
}

export async function finishMobileWebRemoteSpeechSession(
  client: RpcClient,
  dictationId: string
): Promise<MobileWebSpeechStopResult> {
  const response = await client
    .sendRequest(
      'speech.dictation.finish',
      { dictationId },
      { timeoutMs: DICTATION_FINISH_TIMEOUT_MS }
    )
    .catch(() => {
      throw new MobileWebBrokerError('host_error')
    })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  const value = response.result as { text?: unknown }
  const text = typeof value.text === 'string' ? value.text.trim().slice(0, 32 * 1024) : ''
  return text ? { status: 'transcript', text } : { status: 'no-speech' }
}

export async function cancelMobileWebRemoteSpeechSession(
  client: RpcClient,
  dictationId: string
): Promise<void> {
  await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
}

function setupRequiredResult(message: string): MobileWebSpeechStartResult | null {
  if (message === 'voice_dictation_disabled' || message === 'voice_model_not_selected') {
    return { status: 'setup-required', reason: message }
  }
  if (message.startsWith('voice_model_not_ready:')) {
    return { status: 'setup-required', reason: 'voice_model_not_ready' }
  }
  return null
}
