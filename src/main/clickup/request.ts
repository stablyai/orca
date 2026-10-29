import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import type { ClickUpWorkspace } from '../../shared/clickup-types'
import { asRecord } from './json-record'
import { getClickUpRateLimitState, sendWithClickUpRateLimitRetry } from './rate-limit'

const CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2'
// Why: a small pool keeps fan-out (List hierarchy, search paging) from bursting
// through ClickUp's per-token minute budget.
const MAX_CONCURRENT = 3
import {
  CLICKUP_MAX_RATE_LIMIT_WAIT_MS,
  CLICKUP_REQUEST_TIMEOUT_MS
} from '../../shared/clickup-timeouts'

let running = 0
const queue: (() => void)[] = []

export type ClickUpClientForWorkspace = {
  workspace: ClickUpWorkspace
  token: string
}

export class ClickUpApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ClickUpApiError'
    this.status = status
  }
}

export async function acquire(signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted()
  if (running < MAX_CONCURRENT) {
    running += 1
    return
  }
  await new Promise<void>((resolve, reject) => {
    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort)
      running += 1
      resolve()
    }
    const onAbort = (): void => {
      const index = queue.indexOf(grant)
      if (index !== -1) {
        queue.splice(index, 1)
      }
      reject(signal?.reason)
    }
    queue.push(grant)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function release(): void {
  running -= 1
  queue.shift()?.()
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = asRecord(await response.json())
    const message = data?.err ?? data?.error ?? data?.message
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  } catch {
    // Fall through to the HTTP status when ClickUp does not return JSON.
  }
  return response.statusText || `ClickUp request failed (${response.status})`
}

function rateLimitMessage(): string {
  const pausedUntil = getClickUpRateLimitState().pausedUntil
  const seconds = pausedUntil ? Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000)) : null
  return seconds
    ? `ClickUp rate limit reached. Try again in ${seconds}s.`
    : 'ClickUp rate limit reached. Try again shortly.'
}

export async function requestWithToken<T>(
  token: string,
  path: string,
  init?: RequestInit,
  queueSignal?: AbortSignal
): Promise<T> {
  const url = `${CLICKUP_API_BASE_URL}${path}`
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: url
  }).catch(() => undefined)
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Authorization', token)
  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  // Why the port: the desktop gets Electron's net.fetch, which follows Chromium
  // proxy/session state; a host without Chromium gets Node's fetch instead.
  const response = await sendWithClickUpRateLimitRetry(
    () =>
      httpClient.fetch(url, {
        ...init,
        headers,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(CLICKUP_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(CLICKUP_REQUEST_TIMEOUT_MS)
      }),
    init?.signal,
    queueSignal
  )
  if (response.status === 429) {
    throw new ClickUpApiError(rateLimitMessage(), 429)
  }
  if (!response.ok) {
    throw new ClickUpApiError(await readApiError(response), response.status)
  }
  if (response.status === 204) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ClickUp answers 204 only for void mutations, whose callers type T as null or ignore it.
    return null as T
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers name the ClickUp v2 response shape and read it through asRecord/asString guards.
  return (await response.json()) as T
}

// Why: two surfaces asking for the same page at once (task page and composer,
// or a remount) should spend one request, not two.
const inFlightReads = new Map<string, Promise<unknown>>()

function writeNotSentError(): ClickUpApiError {
  return new ClickUpApiError(
    'ClickUp is rate limited, so the change was not sent. Try again shortly.',
    429
  )
}

async function pooledRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  // Why: a write's caller stops waiting after the queue budget plus one request
  // timeout (CLICKUP_WRITE_CLIENT_TIMEOUT_MS). Dropping a write still queued
  // past that budget keeps it from landing after the caller reported failure.
  const isWrite = (init?.method ?? 'GET') !== 'GET'
  const queueDeadline = isWrite ? new AbortController() : null
  const queueTimer = queueDeadline
    ? setTimeout(
        () => queueDeadline.abort(new DOMException('ClickUp write queue expired', 'TimeoutError')),
        CLICKUP_MAX_RATE_LIMIT_WAIT_MS
      )
    : null
  queueTimer?.unref?.()
  const queueSignal = queueDeadline?.signal
  // Why identity: only the queue deadline's own reason means "never sent"; a
  // send that started in time fails with its request timeout instead.
  const notSent = (error: unknown): unknown =>
    queueSignal?.aborted && error === queueSignal.reason ? writeNotSentError() : error
  try {
    await acquire(queueSignal)
  } catch (error) {
    if (queueTimer) {
      clearTimeout(queueTimer)
    }
    throw notSent(error)
  }
  try {
    return await requestWithToken<T>(token, path, init, queueSignal)
  } catch (error) {
    throw notSent(error)
  } finally {
    if (queueTimer) {
      clearTimeout(queueTimer)
    }
    release()
  }
}

export async function clickUpRequest<T>(
  client: ClickUpClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  const isSharedRead = (init?.method ?? 'GET') === 'GET' && !init?.signal
  if (!isSharedRead) {
    return pooledRequest<T>(client.token, path, init)
  }
  const key = `${client.token}\u0000${path}`
  const existing = inFlightReads.get(key)
  if (existing) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key includes the path, so the shared promise resolves the same ClickUp response shape T.
    return existing as Promise<T>
  }
  const request = pooledRequest<T>(client.token, path, init).finally(() =>
    inFlightReads.delete(key)
  )
  inFlightReads.set(key, request)
  return request
}
