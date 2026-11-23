// Share host-local credential commands across IPC/RPC so paired saves reach the usage poller.
import {
  clearMiniMaxSessionCookie,
  getMiniMaxSessionCookieProtection,
  hasMiniMaxSessionCookie,
  COOKIE_ENVELOPE_PREFIX,
  getMiniMaxCookiePath,
  saveMiniMaxSessionCookie
} from './minimax-cookie-store'
import {
  clearMiniMaxApiKey,
  getMiniMaxApiKeyProtection,
  hasMiniMaxApiKey,
  miniMaxApiKeyEnvelopeFile,
  saveMiniMaxApiKey
} from './minimax-api-key-store'
import {
  refuseCredentialSealedElsewhere,
  savedCredentialUnreadable
} from '../credentials/saved-credential-readability'
import { clearMiniMaxSessionCookieJar } from '../rate-limits/providers/minimax/minimax-request-context'
import { refreshAfterCredentialChange } from '../ipc/accounts/credential-change-rate-limit-refresh'
import { getMainHttpClient } from '../network/http-client'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { MiniMaxCredentialsStatus } from '../../shared/agent-accounts/usage-credentials/minimax-credentials-status'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateMiniMaxCredentialState'>

export async function getMiniMaxCredentialsStatus(): Promise<MiniMaxCredentialsStatus> {
  const cookieConfigured = await hasMiniMaxSessionCookie()
  const apiKeyConfigured = await hasMiniMaxApiKey()
  return {
    configured: cookieConfigured || apiKeyConfigured,
    cookieConfigured,
    apiKeyConfigured,
    cookieProtection: cookieConfigured ? await getMiniMaxSessionCookieProtection() : null,
    apiKeyProtection: apiKeyConfigured ? await getMiniMaxApiKeyProtection() : null,
    sessionCookieSupported: getMainHttpClient().partitionSession !== undefined,
    cookieUnreadable: cookieConfigured ? await cookieUnreadable() : undefined,
    apiKeyUnreadable: apiKeyConfigured
      ? await savedCredentialUnreadable(miniMaxApiKeyEnvelopeFile())
      : undefined
  }
}

async function cookieUnreadable(): Promise<ReturnType<typeof savedCredentialUnreadable>> {
  return savedCredentialUnreadable({
    path: getMiniMaxCookiePath(),
    envelopePrefix: COOKIE_ENVELOPE_PREFIX,
    legacyRaw: true
  })
}

/** Refuse unreadable saved credentials; forgetting remains available. */
export async function assertMiniMaxCredentialOpensHere(
  credential: 'apiKey' | 'cookie'
): Promise<void> {
  const unreadable =
    credential === 'apiKey'
      ? await savedCredentialUnreadable(miniMaxApiKeyEnvelopeFile())
      : await cookieUnreadable()
  if (unreadable === 'sealed-elsewhere') {
    refuseCredentialSealedElsewhere(
      credential === 'apiKey' ? 'MiniMax API key' : 'MiniMax session cookie'
    )
  }
}

function refreshAfterChange(rateLimits: UsageRefresher | null, action: 'save' | 'clear'): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateMiniMaxCredentialState(),
    `[minimax] failed to trigger rate-limit refresh after ${action}:`
  )
}

export async function saveMiniMaxSessionCookieCredential(
  rateLimits: UsageRefresher | null,
  cookie: unknown
): Promise<MiniMaxCredentialsStatus> {
  // IPC/RPC values remain untrusted despite the declared type.
  if (typeof cookie !== 'string') {
    throw new Error('MiniMax session cookie must be a string')
  }
  // Cookie acquisition requires a desktop browser session; refuse unusable credentials elsewhere.
  if (getMainHttpClient().partitionSession === undefined) {
    throw new Error(
      'MiniMax session cookies need the Orca desktop app on this computer. Save an API key instead.'
    )
  }
  await saveMiniMaxSessionCookie(cookie)
  refreshAfterChange(rateLimits, 'save')
  return getMiniMaxCredentialsStatus()
}

export async function clearMiniMaxSessionCookieCredential(
  rateLimits: UsageRefresher | null
): Promise<MiniMaxCredentialsStatus> {
  await clearMiniMaxSessionCookie()
  try {
    await clearMiniMaxSessionCookieJar()
  } catch (error) {
    console.error('[minimax] failed to clear session cookie jar after credential clear:', error)
  }
  refreshAfterChange(rateLimits, 'clear')
  return getMiniMaxCredentialsStatus()
}

export async function saveMiniMaxApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): Promise<MiniMaxCredentialsStatus> {
  if (typeof key !== 'string') {
    throw new Error('MiniMax API key must be a string')
  }
  await saveMiniMaxApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getMiniMaxCredentialsStatus()
}

export async function clearMiniMaxApiKeyCredential(
  rateLimits: UsageRefresher | null
): Promise<MiniMaxCredentialsStatus> {
  await clearMiniMaxApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getMiniMaxCredentialsStatus()
}
