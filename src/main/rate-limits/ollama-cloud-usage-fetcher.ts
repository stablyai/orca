import type { Session } from 'electron'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  clearOllamaCloudSessionCookies,
  createOllamaCloudRequestSession,
  OLLAMA_CLOUD_BASE_URL
} from './ollama-cloud-request-session'
import { parseOllamaCloudFromPageText } from './ollama-cloud-page-scraper'

const SETTINGS_URL = `${OLLAMA_CLOUD_BASE_URL}/settings`
const API_TIMEOUT_MS = 15_000

// Only this cookie name carries session auth on ollama.com.
const AUTH_COOKIE_NAMES = new Set(['__Secure-session'])

// Why: users may paste just the token value instead of the full cookie header.
// Auto-wrapping avoids a confusing silent failure.
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return trimmed
  }
  // Already a valid cookie header: has multiple pairs or starts with known name.
  if (trimmed.includes(';') || /^__Secure-session=/i.test(trimmed)) {
    return trimmed
  }
  // Wrap any non-empty value with __Secure-session= — the user may have
  // pasted just the token, the full header, or even JSON format.
  return `__Secure-session=${trimmed}`
}

function parseAuthCookies(raw: string): { name: string; value: string }[] {
  return raw
    .split(';')
    .map((p) => p.trim())
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) {
        return null
      }
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return AUTH_COOKIE_NAMES.has(name) && value ? { name, value } : null
    })
    .filter((pair): pair is { name: string; value: string } => pair !== null)
}

function makeWindow(
  usedPercent: number,
  resetInSec: number | null,
  windowMinutes: number
): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: resetInSec !== null ? Date.now() + resetInSec * 1000 : null,
    resetDescription: null
  }
}

export async function fetchOllamaCloudRateLimits(
  cookie: string,
  networkProxySettings?: NetworkProxySettings
): Promise<ProviderRateLimits> {
  // Normalize before any guard — bare tokens become __Secure-session=<token>.
  const normalizedCookie = normalizeCookieInput(cookie)

  if (!normalizedCookie) {
    return {
      provider: 'ollama-cloud',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Session cookie not configured',
      status: 'unavailable'
    }
  }

  // Filter to only auth cookies — avoids sending unrelated session data.
  const authCookies = parseAuthCookies(normalizedCookie)
  if (authCookies.length === 0) {
    return {
      provider: 'ollama-cloud',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error:
        'No __Secure-session cookie found — paste the full Cookie header from ollama.com DevTools',
      status: 'error'
    }
  }

  // Why: Chromium can reject a manually supplied Cookie header on Windows.
  // An isolated session jar lets its network stack attach auth normally.
  let ollamaCloudSession: Session
  try {
    ollamaCloudSession = await createOllamaCloudRequestSession(authCookies, networkProxySettings)
  } catch (error) {
    return makeOllamaCloudError(error)
  }

  try {
    return await fetchOllamaCloudRateLimitsWithSession(ollamaCloudSession)
  } finally {
    await clearOllamaCloudSessionCookies(ollamaCloudSession).catch((error: unknown) => {
      console.warn('[ollama-cloud] failed to clear session cookie jar after fetch', error)
    })
  }
}

function makeOllamaCloudError(error: unknown): ProviderRateLimits {
  return {
    provider: 'ollama-cloud',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : 'Unknown error',
    status: 'error'
  }
}

async function fetchOllamaCloudRateLimitsWithSession(
  ollamaCloudSession: Session
): Promise<ProviderRateLimits> {
  try {
    const pageRes = await ollamaCloudSession.fetch(SETTINGS_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: OLLAMA_CLOUD_BASE_URL,
        Referer: OLLAMA_CLOUD_BASE_URL
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })

    if (!pageRes.ok) {
      return {
        provider: 'ollama-cloud',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Settings page fetch failed (${pageRes.status})`,
        status: 'error'
      }
    }

    const pageText = await pageRes.text()
    const parsed = parseOllamaCloudFromPageText(pageText)
    if (!parsed) {
      return {
        provider: 'ollama-cloud',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Could not parse usage data from settings page',
        status: 'error'
      }
    }

    return {
      provider: 'ollama-cloud',
      session: makeWindow(parsed.sessionPercent, parsed.sessionResetInSec, 300),
      weekly: makeWindow(parsed.weeklyPercent, parsed.weeklyResetInSec, 10080),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'ollama-cloud',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  }
}
