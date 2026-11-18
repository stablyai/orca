// Saving, clearing and reporting the Gemini API key Orca's Antigravity chat uses on this host.

import type { AntigravityChatApiKeyStatus } from '../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { getMainHttpClient } from '../network/http-client'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  clearAntigravityChatApiKey,
  hasAntigravityChatApiKey,
  saveAntigravityChatApiKey
} from './antigravity-chat-api-key-store'

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1'

/** Rejects a key Google refuses; an unreachable Google keeps it so offline saves still work. */
async function assertGoogleAcceptsKey(apiKey: string): Promise<void> {
  let response: Response
  try {
    response = await getMainHttpClient().fetch(MODELS_URL, {
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    return
  }
  await cancelUnreadResponseBody(response)
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error('Google rejected this Gemini API key. Check it and paste it again.')
  }
}

export async function readAntigravityChatApiKeyStatus(
  launchEnv: () => Promise<Readonly<Record<string, string>>>
): Promise<AntigravityChatApiKeyStatus> {
  const [saved, env] = await Promise.all([hasAntigravityChatApiKey(), launchEnv()])
  return { saved, inEnvironment: Boolean(env.GEMINI_API_KEY?.trim()) }
}

export async function storeAntigravityChatApiKey(apiKey: string): Promise<void> {
  await assertGoogleAcceptsKey(apiKey.trim())
  await saveAntigravityChatApiKey(apiKey)
}

export { clearAntigravityChatApiKey }
