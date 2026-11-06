import http from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import https from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { getMainHttpClient } from '../network/http-client'

/** Claude Code 2.1.314 axios 1.15.2 http adapter. A browser user-agent is answered 429. */
export const CLAUDE_OAUTH_TOKEN_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'axios/1.15.2',
  'Accept-Encoding': 'gzip, compress, deflate, br'
} as const

const REQUEST_TIMEOUT_MS = 30_000
const SKIP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding'
])

export type NodeHttpRequest = (
  url: string | URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest

export function claudeOAuthNodeFetch(url: string, init?: RequestInit): Promise<Response> {
  const request = new URL(url).protocol === 'http:' ? httpTokenRequest : httpsTokenRequest
  return nodeHttpFetch(request, url, init)
}

/** Electron's session client is answered 429. A client with no session keeps its own fetch. */
export function claudeOAuthTokenFetch(url: string, init?: RequestInit): Promise<Response> {
  const client = getMainHttpClient()
  if (client.proxySession()) {
    return claudeOAuthNodeFetch(url, init)
  }
  return client.fetch(url, init)
}

function httpTokenRequest(
  url: string | URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
): ClientRequest {
  return http.request(url, options, callback)
}

function httpsTokenRequest(
  url: string | URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
): ClientRequest {
  return https.request(url, options, callback)
}

export function nodeHttpFetch(
  request: NodeHttpRequest,
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (init?.body != null && typeof init.body !== 'string') {
    return Promise.reject(new Error('Claude token request body must be a string'))
  }
  if (init?.signal?.aborted) {
    return Promise.reject(abortError(init.signal))
  }
  let target: URL
  try {
    target = new URL(url)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Claude token request failed'))
  }
  const body = typeof init?.body === 'string' ? init.body : null
  const headers = headerRecord(init?.headers)
  if (body !== null) {
    headers['Content-Length'] = String(Buffer.byteLength(body))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const stop = (listener: () => void): void => {
      init?.signal?.removeEventListener('abort', listener)
    }
    let onAbort = (): void => {}
    const finish = (error: unknown, response?: Response): void => {
      if (settled) {
        return
      }
      settled = true
      stop(onAbort)
      if (error) {
        reject(error instanceof Error ? error : new Error('Claude token request failed'))
        return
      }
      resolve(response ?? new Response(null, { status: 502 }))
    }
    // Axios maxRedirects 0: a 3xx must not replay the body to Location.
    const req = request(
      target,
      {
        method: init?.method ?? 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        })
        res.on('aborted', () => {
          finish(new Error('Claude token response closed early'))
        })
        res.on('error', (error) => {
          finish(error)
        })
        res.on('end', () => {
          try {
            const decoded = decodeBody(
              Buffer.concat(chunks),
              firstEncoding(res.headers['content-encoding'])
            )
            finish(null, toResponse(res, decoded))
          } catch (error) {
            finish(error)
          }
        })
      }
    )
    onAbort = (): void => {
      req.destroy(abortError(init?.signal ?? undefined))
    }
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('timeout', () => {
      req.destroy(new Error('Claude token request timed out'))
    })
    req.on('error', (error) => {
      finish(error)
    })
    req.end(body ?? undefined)
  })
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Claude token request aborted')
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const assign = (key: string, value: string): void => {
    if (key.toLowerCase() === 'cookie') {
      return
    }
    out[key] = value
  }
  if (!headers) {
    return out
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      assign(key, value)
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      assign(key, value)
    }
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      assign(key, value)
    }
  }
  return out
}

function firstEncoding(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim().toLowerCase() ?? ''
}

function decodeBody(raw: Buffer, encoding: string): Buffer {
  if (encoding === '' || encoding === 'identity') {
    return raw
  }
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return gunzipSync(raw)
  }
  if (encoding === 'deflate') {
    return inflateSync(raw)
  }
  if (encoding === 'br') {
    return brotliDecompressSync(raw)
  }
  throw new Error('unsupported content-encoding')
}

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const status = res.statusCode ?? 0
  if (status < 100 || status > 599) {
    throw new Error('Claude token response had no status')
  }
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || SKIP_RESPONSE_HEADERS.has(key)) {
      continue
    }
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      headers.append(key, item)
    }
  }
  headers.set('content-length', String(body.byteLength))
  return new Response(new Uint8Array(body), { status, headers })
}
