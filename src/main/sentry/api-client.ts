import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'

const REQUEST_TIMEOUT_MS = 30_000

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfter: string | null = null
  ) {
    super(message)
  }
}

export function normalizeSentryBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Sentry URL must use HTTP or HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter the base URL without credentials, a query, or a fragment.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown; error?: unknown }
    const message = typeof data.detail === 'string' ? data.detail : data.error
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  } catch {
    // Fall back to HTTP status text.
  }
  return response.statusText || `Sentry request failed (${response.status})`
}

export async function sentryRequest<T>(args: {
  baseUrl: string
  token: string
  path: string
  search?: URLSearchParams
  init?: RequestInit
}): Promise<{ value: T; headers: Headers }> {
  const base = `${args.baseUrl.replace(/\/+$/, '')}/`
  const url = new URL(args.path.replace(/^\/+/, ''), base)
  if (url.origin !== new URL(base).origin) {
    throw new SentryApiError('Sentry request must use the configured origin.')
  }
  if (args.search) {
    url.search = args.search.toString()
  }
  const headers = new Headers(args.init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${args.token}`)
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: url.toString()
  }).catch(() => undefined)
  const signal = args.init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await httpClient.fetch(url.toString(), { ...args.init, headers, signal })
  if (!response.ok) {
    throw new SentryApiError(
      await readError(response),
      response.status,
      response.headers.get('retry-after')
    )
  }
  const value = response.status === 204 ? null : await response.json()
  return { value: value as T, headers: response.headers }
}

export function parseSentryPagination(headers: Headers): {
  nextCursor: string | null
  previousCursor: string | null
} {
  const link = headers.get('link') ?? ''
  const cursor = (rel: 'next' | 'previous'): string | null => {
    for (const part of link.split(/,(?=\s*<)/)) {
      if (!new RegExp(`rel=["']?${rel}["']?`).test(part)) {
        continue
      }
      if (/results=["']?false["']?/.test(part)) {
        return null
      }
      const explicit = part.match(/cursor=["']([^"']+)["']/)?.[1]
      if (explicit) {
        return explicit
      }
      const target = part.match(/<([^>]+)>/)?.[1]
      if (target) {
        return new URL(target).searchParams.get('cursor')
      }
    }
    return null
  }
  return { nextCursor: cursor('next'), previousCursor: cursor('previous') }
}
