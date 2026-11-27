import { isIP } from 'node:net'
import type { ItsaplanResult } from '../../shared/itsaplan/itsaplan-types'
import { getMainHttpClient } from '../network/http-client'

const PROBE_TIMEOUT_MS = 5_000

export function normalizeItsaplanAppUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

export function itsaplanApiUrlCandidates(appUrl: string): string[] {
  const candidates = [`${appUrl}/api`, appUrl]
  const url = new URL(appUrl)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname !== 'localhost' && isIP(hostname) === 0) {
    candidates.push(`${url.protocol}//api.${url.host}`)
  }
  return candidates
}

async function probeMeEndpoint(apiUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  const response = await fetchImpl(`${apiUrl}/me`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  if (!response.ok) {
    return false
  }
  try {
    const body: unknown = await response.json()
    return (
      typeof body === 'object' &&
      body !== null &&
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: body is checked to be a non-null object above.
      typeof (body as { authenticated?: unknown }).authenticated === 'boolean'
    )
  } catch {
    // An HTML catch-all or empty body is not the API.
    return false
  }
}

export async function detectItsaplanApiUrl(
  appUrlInput: string,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mainFetch is Electron net.fetch, call-compatible with global fetch.
  fetchImpl: typeof fetch = ((url, init) =>
    getMainHttpClient().fetch(String(url), init)) as typeof fetch
): Promise<ItsaplanResult<{ appUrl: string; apiUrl: string }>> {
  const appUrl = normalizeItsaplanAppUrl(appUrlInput)
  if (!appUrl) {
    return { ok: false, error: 'invalidUrl', message: 'Enter a valid http(s) address.' }
  }
  let reachedAny = false
  for (const apiUrl of itsaplanApiUrlCandidates(appUrl)) {
    try {
      const matched = await probeMeEndpoint(apiUrl, fetchImpl)
      reachedAny = true
      if (matched) {
        return { ok: true, appUrl, apiUrl }
      }
    } catch {
      // Network failure on this candidate; try the next one.
    }
  }
  return reachedAny
    ? {
        ok: false,
        error: 'apiNotFound',
        message: 'Could not find the It’s a Plan API at this address.'
      }
    : { ok: false, error: 'unreachable', message: 'Could not reach this address.' }
}
