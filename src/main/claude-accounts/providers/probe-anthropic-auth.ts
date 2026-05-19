import type { ValidationResult } from './types'

// Why: 5s is generous enough for sluggish provider endpoints on consumer ISPs
// without making the "Re-check" button feel hung. The error string for the
// timeout branch reassures users the account is still saved.
const DEFAULT_TIMEOUT_MS = 5000

export type ProbeAnthropicAuthInput = {
  url: string
  headers: Record<string, string>
  reason401: string
  rescue401: string
  reason403?: string
  rescue403?: string
  timeoutMs?: number
}

/**
 * Probe an Anthropic-shaped `GET /v1/models` endpoint and translate the HTTP
 * status (or network failure) into the locked validation error strings used
 * across the Claude account UI. Shared between the first-party Anthropic API
 * key handler and the Anthropic-compatible provider handler so both surface
 * identical wording for identical conditions.
 */
export async function probeAnthropicAuth(
  input: ProbeAnthropicAuthInput
): Promise<ValidationResult> {
  const {
    url,
    headers,
    reason401,
    rescue401,
    reason403 = 'API key does not have Claude access.',
    rescue403 = 'Confirm your Anthropic Console workspace has Claude API access enabled.',
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = input

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (res.ok) return { ok: true }
    if (res.status === 401) {
      return { ok: false, reason: reason401, rescueHint: rescue401 }
    }
    if (res.status === 403) {
      return { ok: false, reason: reason403, rescueHint: rescue403 }
    }
    return {
      ok: false,
      reason: 'Provider returned an error.',
      rescueHint: 'Try again in a moment. If this persists, check provider status.'
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return {
        ok: false,
        reason: 'Validation request timed out.',
        rescueHint:
          'Network may be slow; the account is still saved and will be used when you next launch Claude.'
      }
    }
    return {
      ok: false,
      reason: 'Unable to reach the provider.',
      rescueHint: 'Check your network connection or proxy settings, then try again.'
    }
  } finally {
    clearTimeout(timer)
  }
}
