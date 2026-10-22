/**
 * MiniMax usage credentials on this host, shared by the desktop's IPC and the runtime RPC so a
 * paired client saves them where the usage poller runs. Nothing here may import Electron.
 */
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
import { clearMiniMaxSessionCookieJar } from '../rate-limits/minimax/minimax-request-context'
import { refreshAfterCredentialChange } from '../ipc/credential-change-rate-limit-refresh'
import { getMainHttpClient } from '../network/http-client'
import type { RateLimitService } from '../rate-limits/service'
import type { MiniMaxCredentialsStatus } from '../../shared/minimax-credentials-status'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateMiniMaxCredentialState'>

export function getMiniMaxCredentialsStatus(): MiniMaxCredentialsStatus {
  const cookieConfigured = hasMiniMaxSessionCookie()
  const apiKeyConfigured = hasMiniMaxApiKey()
  return {
    configured: cookieConfigured || apiKeyConfigured,
    cookieConfigured,
    apiKeyConfigured,
    cookieProtection: cookieConfigured ? getMiniMaxSessionCookieProtection() : null,
    apiKeyProtection: apiKeyConfigured ? getMiniMaxApiKeyProtection() : null,
    sessionCookieSupported: getMainHttpClient().partitionSession !== undefined,
    cookieUnreadable: cookieConfigured ? cookieUnreadable() : undefined,
    apiKeyUnreadable: apiKeyConfigured
      ? savedCredentialUnreadable(miniMaxApiKeyEnvelopeFile())
      : undefined
  }
}

function cookieUnreadable(): ReturnType<typeof savedCredentialUnreadable> {
  return savedCredentialUnreadable({
    path: getMiniMaxCookiePath(),
    envelopePrefix: COOKIE_ENVELOPE_PREFIX,
    legacyRaw: true
  })
}

/** For a paired client's save; forgetting is always allowed, since nobody here can read the file. */
export function assertMiniMaxCredentialOpensHere(credential: 'apiKey' | 'cookie'): void {
  const unreadable =
    credential === 'apiKey'
      ? savedCredentialUnreadable(miniMaxApiKeyEnvelopeFile())
      : cookieUnreadable()
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

export function saveMiniMaxSessionCookieCredential(
  rateLimits: UsageRefresher | null,
  cookie: unknown
): MiniMaxCredentialsStatus {
  // Why: the value arrives as unknown over IPC/RPC; the declared type is compile-time only.
  if (typeof cookie !== 'string') {
    throw new Error('MiniMax session cookie must be a string')
  }
  // Why: the cookie fetch runs in the desktop's browser session; refuse rather than store a dead key.
  if (getMainHttpClient().partitionSession === undefined) {
    throw new Error(
      'MiniMax session cookies need the Orca desktop app on this computer. Save an API key instead.'
    )
  }
  saveMiniMaxSessionCookie(cookie)
  refreshAfterChange(rateLimits, 'save')
  return getMiniMaxCredentialsStatus()
}

export async function clearMiniMaxSessionCookieCredential(
  rateLimits: UsageRefresher | null
): Promise<MiniMaxCredentialsStatus> {
  clearMiniMaxSessionCookie()
  try {
    await clearMiniMaxSessionCookieJar()
  } catch (error) {
    console.error('[minimax] failed to clear session cookie jar after credential clear:', error)
  }
  refreshAfterChange(rateLimits, 'clear')
  return getMiniMaxCredentialsStatus()
}

export function saveMiniMaxApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): MiniMaxCredentialsStatus {
  if (typeof key !== 'string') {
    throw new Error('MiniMax API key must be a string')
  }
  saveMiniMaxApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getMiniMaxCredentialsStatus()
}

export function clearMiniMaxApiKeyCredential(
  rateLimits: UsageRefresher | null
): MiniMaxCredentialsStatus {
  clearMiniMaxApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getMiniMaxCredentialsStatus()
}
