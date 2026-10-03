import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { isRawRecord } from './raw-record'

const REQUEST_TIMEOUT_MS = 30_000

export class YouTrackApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'YouTrackApiError'
    this.status = status
  }
}

/** Fetch that trusts `hostname`'s certificate as-is; only the desktop host can provide one. */
export type YouTrackInsecureTlsFetch = (
  hostname: string,
  url: string,
  init: RequestInit
) => Promise<Response>

let insecureTlsFetch: YouTrackInsecureTlsFetch | null = null

export function setYouTrackInsecureTlsFetch(fetcher: YouTrackInsecureTlsFetch | null): void {
  insecureTlsFetch = fetcher
}

export type YouTrackCredentials = {
  baseUrl: string
  token: string
  /** Skip TLS certificate verification for this host (self-signed / internal CA). */
  allowInsecureTls?: boolean
}

function parseYouTrackAddress(input: string): URL {
  const trimmed = input.trim()
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('unsupported protocol')
  }
  return url
}

/** Accepts the address users copy from the browser and returns the instance root. */
export function normalizeYouTrackBaseUrl(input: string): string {
  const url = parseYouTrackAddress(input)
  // Why: self-hosted instances often live under a path prefix (e.g. /youtrack), so keep it.
  // An API path runs to the end; of UI segments only the last is the pasted page.
  const path = url.pathname
    .replace(/\/api(?:\/.*)?$/i, '')
    .replace(/^(.*)\/(?:issues?|dashboard|agiles|projects)(?:\/.*)?$/i, '$1')
    .replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** Base URLs to try on connect: the normalized root, then the path exactly as entered. */
export function youtrackBaseUrlCandidates(input: string): string[] {
  const url = parseYouTrackAddress(input)
  const asEntered = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return [...new Set([normalizeYouTrackBaseUrl(input), asEntered])]
}

async function readYouTrackError(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json()
    if (isRawRecord(data)) {
      const message = data.error_description || data.error
      if (typeof message === 'string' && message) {
        return message
      }
    }
  } catch {
    // Fall through to status text.
  }
  if (response.status === 401) {
    return 'YouTrack rejected the token. Check that it is a valid permanent token.'
  }
  return response.statusText || `YouTrack request failed (${response.status})`
}

// Why: Chromium reports TLS failures as bare net::ERR_* codes; point users at the fix.
function describeTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /ERR_CERT_|CERT_|certificate/i.test(message)
    ? `${message}. If your YouTrack uses a self-signed or internal certificate, reconnect with "Skip certificate verification".`
    : message
}

export async function youtrackRequest(
  credentials: YouTrackCredentials,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const url = `${credentials.baseUrl}${path}`
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: url
  }).catch(() => {
    // Proxy discovery is best-effort; the request below reports real failures.
  })
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${credentials.token}`)
  const requestInit = {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }
  let response: Response
  try {
    if (credentials.allowInsecureTls) {
      if (!insecureTlsFetch) {
        throw new Error('Skipping certificate verification needs the Orca desktop app')
      }
      response = await insecureTlsFetch(new URL(url).hostname, url, requestInit)
    } else {
      response = await httpClient.fetch(url, requestInit)
    }
  } catch (error) {
    const message = describeTransportError(error)
    throw new YouTrackApiError(`Could not reach YouTrack at ${credentials.baseUrl}: ${message}`)
  }
  if (!response.ok) {
    throw new YouTrackApiError(await readYouTrackError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}
