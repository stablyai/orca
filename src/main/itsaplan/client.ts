import type {
  ItsaplanFailureCode,
  ItsaplanInstance,
  ItsaplanResult,
  ItsaplanViewer
} from '../../shared/itsaplan/itsaplan-types'
import { getMainHttpClient } from '../network/http-client'
import { readItsaplanApiKey, readItsaplanInstance } from './instance-credential-store'
import { acquire, release } from './request-queue'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRY_AFTER_MS = 10_000

const FAILURE_TEXT: Record<ItsaplanFailureCode, string> = {
  notConnected: 'It’s a Plan is not connected.',
  invalidUrl: 'The address is not valid.',
  apiNotFound: 'The It’s a Plan API was not found at this address.',
  invalidApiKey: 'API key invalid, reconnect.',
  forbidden: 'This API key cannot access that resource.',
  unreachable: 'Could not reach It’s a Plan.',
  notFound: 'Not found.',
  rateLimited: 'Too many requests, try again shortly.',
  requestFailed: 'The request failed.'
}

export class ItsaplanApiError extends Error {
  constructor(
    public code: ItsaplanFailureCode,
    public status: number | null = null,
    detail?: string
  ) {
    super(`${code}: ${detail ?? FAILURE_TEXT[code]}`)
    this.name = 'ItsaplanApiError'
  }
}

export function classifyItsaplanResponse(status: number): ItsaplanFailureCode {
  if (status === 401) {
    return 'invalidApiKey'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 404) {
    return 'notFound'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  return 'requestFailed'
}

export type ItsaplanQueryValue = string | number | string[] | number[] | undefined

export type ItsaplanRequestInit = {
  method?: 'GET' | 'POST' | 'PATCH'
  query?: Record<string, ItsaplanQueryValue>
  body?: unknown
}

function buildUrl(
  apiUrl: string,
  path: string,
  query?: Record<string, ItsaplanQueryValue>
): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue
    }
    // The API takes list filters (labelIds) as one comma-separated value.
    params.set(name, Array.isArray(value) ? value.join(',') : String(value))
  }
  const search = params.toString()
  return `${apiUrl}${path}${search ? `?${search}` : ''}`
}

function isRedirectFailure(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return [error, cause].some(
    (candidate) => candidate instanceof Error && /redirect/i.test(candidate.message)
  )
}

async function sendWithKey(
  url: string,
  apiKey: string,
  init: ItsaplanRequestInit | undefined,
  fetchImpl: typeof fetch
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': apiKey }
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  try {
    return await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      // A redirect would resend x-api-key to the new origin.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    // The raw error can carry request config; surface only the code.
    if (isRedirectFailure(error)) {
      throw new ItsaplanApiError(
        'requestFailed',
        null,
        'The server redirected the request. Check the API URL.'
      )
    }
    throw new ItsaplanApiError('unreachable')
  }
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : 1000
}

function mainFetch(url: string, init?: RequestInit): Promise<Response> {
  return getMainHttpClient().fetch(url, init)
}

async function requireConnection(): Promise<{ instance: ItsaplanInstance; apiKey: string }> {
  const instance = await readItsaplanInstance()
  if (!instance) {
    throw new ItsaplanApiError('notConnected')
  }
  let apiKey: string | null
  try {
    apiKey = await readItsaplanApiKey(instance.id)
  } catch {
    apiKey = null
  }
  if (!apiKey) {
    throw new ItsaplanApiError('invalidApiKey')
  }
  return { instance, apiKey }
}

export async function itsaplanRequest<T>(path: string, init?: ItsaplanRequestInit): Promise<T> {
  const { instance, apiKey } = await requireConnection()
  const url = buildUrl(instance.apiUrl, path, init?.query)
  await acquire()
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mainFetch is Electron net.fetch, call-compatible with global fetch.
    let response = await sendWithKey(url, apiKey, init, mainFetch as typeof fetch)
    if (response.status === 429) {
      const delay = retryAfterMs(response)
      await response.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, delay))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mainFetch is Electron net.fetch, call-compatible with global fetch.
      response = await sendWithKey(url, apiKey, init, mainFetch as typeof fetch)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ItsaplanApiError(classifyItsaplanResponse(response.status), response.status)
    }
    if (response.status === 204) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a 204 has no body, so callers asking for void get undefined.
      return undefined as T
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the API response is trusted to match the caller-declared shape; there is no runtime schema.
      return (await response.json()) as T
    } catch {
      throw new ItsaplanApiError('requestFailed', response.status, 'Unexpected response.')
    }
  } finally {
    release()
  }
}

export async function verifyItsaplanKey(
  apiUrl: string,
  apiKey: string,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mainFetch is Electron net.fetch, call-compatible with global fetch.
  fetchImpl: typeof fetch = mainFetch as typeof fetch
): Promise<ItsaplanResult<{ viewer: ItsaplanViewer }>> {
  try {
    const response = await sendWithKey(`${apiUrl}/me`, apiKey, undefined, fetchImpl)
    if (!response.ok) {
      const code = classifyItsaplanResponse(response.status)
      return { ok: false, error: code, message: FAILURE_TEXT[code] }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is narrowed from unknown before use.
    const body = (await response.json()) as {
      authenticated?: unknown
      user?: { id?: unknown; name?: unknown; email?: unknown }
    }
    if (body.authenticated !== true || typeof body.user?.id !== 'string') {
      return { ok: false, error: 'invalidApiKey', message: FAILURE_TEXT.invalidApiKey }
    }
    return {
      ok: true,
      viewer: {
        id: body.user.id,
        name: typeof body.user.name === 'string' ? body.user.name : body.user.id,
        email: typeof body.user.email === 'string' && body.user.email ? body.user.email : null
      }
    }
  } catch (error) {
    const code = error instanceof ItsaplanApiError ? error.code : 'requestFailed'
    return { ok: false, error: code, message: FAILURE_TEXT[code] }
  }
}
