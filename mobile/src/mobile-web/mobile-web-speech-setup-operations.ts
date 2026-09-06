import {
  MobileWebSpeechConfigurePayloadSchema,
  MobileWebSpeechDeleteModelResultSchema,
  MobileWebSpeechModelActionPayloadSchema,
  MobileWebSpeechSetupPayloadSchema,
  MobileWebSpeechSetupResultSchema,
  type MobileWebSpeechConfigurePayload,
  type MobileWebSpeechSetup
} from '../../../src/shared/mobile-web/speech-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export async function loadMobileWebSpeechSetup(
  client: RpcClient,
  payload: unknown
): Promise<MobileWebSpeechSetup> {
  MobileWebSpeechSetupPayloadSchema.parse(payload)
  const result = await sendSpeechRequest(client, 'speech.models.list', null)
  return MobileWebSpeechSetupResultSchema.parse(result)
}

export async function downloadMobileWebSpeechModel(
  client: RpcClient,
  payload: unknown
): Promise<null> {
  const { modelId } = MobileWebSpeechModelActionPayloadSchema.parse(payload)
  await sendSpeechRequest(client, 'speech.models.download', { modelId })
  return null
}

export async function deleteMobileWebSpeechModel(
  client: RpcClient,
  payload: unknown
): Promise<MobileWebSpeechSetup> {
  const { modelId } = MobileWebSpeechModelActionPayloadSchema.parse(payload)
  const result = await sendSpeechRequest(client, 'speech.models.delete', { modelId })
  return MobileWebSpeechDeleteModelResultSchema.parse(result)
}

export async function configureMobileWebSpeech(
  client: RpcClient,
  payload: unknown
): Promise<MobileWebSpeechSetup> {
  const config: MobileWebSpeechConfigurePayload =
    MobileWebSpeechConfigurePayloadSchema.parse(payload)
  const result = await sendSpeechRequest(client, 'speech.dictation.setup', config)
  return MobileWebSpeechSetupResultSchema.parse(result)
}

async function sendSpeechRequest(
  client: RpcClient,
  method: string,
  payload: unknown
): Promise<unknown> {
  const response = await client.sendRequest(method, payload)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return response.result
}
