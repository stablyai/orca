import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  speechProviderKeyClear,
  speechProviderKeySave,
  speechProviderKeyTest,
  speechProvidersConfigure,
  speechProvidersRead
} from './mobile-speech-provider-operations'
import type {
  MobileSpeechProviderKeyTest,
  MobileSpeechProvidersState
} from './speech-provider-reply-schema'

export const SPEECH_PROVIDERS_UNAVAILABLE_MESSAGE =
  'Update the paired desktop Orca app to manage speech providers from your phone.'

/**
 * The cabinet state, or null when the paired desktop predates `speech.providers.*` — the caller
 * then keeps the legacy voice screen. Older desktops refuse with `forbidden` from the mobile gate
 * before `method_not_found` can happen, which isMobileMethodUnavailableError covers.
 */
export async function fetchSpeechProviders(
  client: RpcClient
): Promise<MobileSpeechProvidersState | null> {
  const reply = await requestSpeechProvidersReply(client)
  if (!reply.ok && isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
    return null
  }
  return interpretOrThrowRefusalMessage(
    () => speechProvidersRead.interpret(reply),
    'Failed to load speech providers'
  )
}

async function requestSpeechProvidersReply(client: RpcClient): Promise<RpcResponse> {
  try {
    return await speechProvidersRead.request(client, null)
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      throw error
    }
    // Why: a read is safe to repeat on the replacement client; writes below must surface cutover.
    return speechProvidersRead.request(client, null)
  }
}

/** Verify-then-save: a key the provider rejects throws the host's sanitized message and is not stored. */
export async function saveSpeechProviderKey(
  client: RpcClient,
  providerId: string,
  apiKey: string
): Promise<MobileSpeechProvidersState> {
  const reply = await speechProviderKeySave.request(client, { providerId, apiKey, verify: true })
  return interpretOrThrowRefusalMessage(
    () => speechProviderKeySave.interpret(reply),
    'Could not save the API key'
  )
}

export async function clearSpeechProviderKey(
  client: RpcClient,
  providerId: string
): Promise<MobileSpeechProvidersState> {
  const reply = await speechProviderKeyClear.request(client, { providerId })
  return interpretOrThrowRefusalMessage(
    () => speechProviderKeyClear.interpret(reply),
    'Could not remove the API key'
  )
}

export async function testSpeechProviderKey(
  client: RpcClient,
  providerId: string
): Promise<MobileSpeechProviderKeyTest> {
  const reply = await speechProviderKeyTest.request(client, { providerId })
  return interpretOrThrowRefusalMessage(
    () => speechProviderKeyTest.interpret(reply),
    'Could not test the API key'
  )
}

export async function setSpeechTranscriptionLanguage(
  client: RpcClient,
  language: string
): Promise<MobileSpeechProvidersState> {
  const reply = await speechProvidersConfigure.request(client, { language })
  return interpretOrThrowRefusalMessage(
    () => speechProvidersConfigure.interpret(reply),
    'Could not change the language'
  )
}
