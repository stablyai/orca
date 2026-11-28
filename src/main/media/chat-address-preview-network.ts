import { session } from 'electron'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { parsePreviewNetworkUrl, resolvePreviewAddresses } from './chat-address-preview-security'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'

export const CHAT_PREVIEW_MAX_REDIRECTS = 4
export const CHAT_PREVIEW_MAX_NETWORK_REQUESTS = 256
export const CHAT_PREVIEW_NETWORK_TIMEOUT_MS = 30_000
export type PreviewNetworkBudget = { requests: number }
export type PreviewNetworkResponse = {
  response: IncomingMessage
  url: URL
  close: () => void
}

let activeRequests = 0
const MAX_ACTIVE_REQUESTS = 32
const CONNECTION_FAILURE_CODES: Record<string, boolean> = {
  EADDRNOTAVAIL: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  ETIMEDOUT: true
}

/** A pinned direct socket must never bypass the app's configured or system proxy. */
async function assertDirectPreviewPolicy(url: URL, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const proxySession = session.defaultSession
  if (getProxySessionApplicationReadiness(proxySession) !== true) {
    throw new Error('Preview network policy is not ready')
  }
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => cancelled.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => cancelled.reject(new Error('Preview request timed out')),
    CHAT_PREVIEW_NETWORK_TIMEOUT_MS
  )
  timer.unref()
  try {
    const proxy = await Promise.race([proxySession.resolveProxy(url.href), cancelled.promise])
    signal.throwIfAborted()
    if (proxy !== 'DIRECT' || getProxySessionApplicationReadiness(proxySession) !== true) {
      throw new Error('Address previews cannot bypass the configured network proxy')
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function requestPinned(
  url: URL,
  options: {
    allowPrivateNetwork: boolean
    signal: AbortSignal
    budget: PreviewNetworkBudget
    range?: string
    media?: boolean
  }
): Promise<PreviewNetworkResponse> {
  if (
    options.budget.requests >= CHAT_PREVIEW_MAX_NETWORK_REQUESTS ||
    activeRequests >= MAX_ACTIVE_REQUESTS
  ) {
    throw new Error('Preview network request limit reached')
  }
  options.budget.requests++
  activeRequests++
  let response: IncomingMessage | undefined
  let closed = false
  let timer: NodeJS.Timeout | undefined
  const closeCount = (): void => {
    if (closed) {
      return
    }
    closed = true
    activeRequests--
    clearTimeout(timer)
  }
  try {
    await assertDirectPreviewPolicy(url, options.signal)
    const targets = await resolvePreviewAddresses(url, options.allowPrivateNetwork, options.signal)
    for (let index = 0; index < targets.length; index++) {
      if (index > 0) {
        if (options.budget.requests >= CHAT_PREVIEW_MAX_NETWORK_REQUESTS) {
          throw new Error('Preview network request limit reached')
        }
        options.budget.requests++
      }
      await assertDirectPreviewPolicy(url, options.signal)
      options.signal.throwIfAborted()
      const target = targets[index]
      const pending = Promise.withResolvers<PreviewNetworkResponse>()
      const requestOptions: RequestOptions = {
        protocol: url.protocol,
        // Every attempt uses the same checked DNS snapshot; Host and TLS identity stay original.
        hostname: target.address,
        family: target.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        method: 'GET',
        agent: false,
        maxHeaderSize: 16 * 1024,
        signal: options.signal,
        headers: {
          Host: url.host,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...(options.range ? { Range: options.range } : {})
        }
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        requestOptions,
        (incoming) => {
          response = incoming
          if (options.media) {
            clearTimeout(timer)
          }
          incoming.once('close', closeCount)
          incoming.once('error', () => {})
          pending.resolve({
            response: incoming,
            url,
            close: () => {
              incoming.destroy()
              request.destroy()
              closeCount()
            }
          })
        }
      )
      request.once('error', (error) => {
        response?.destroy(error)
        if (response) {
          closeCount()
        }
        pending.reject(error)
      })
      timer = setTimeout(
        () =>
          request.destroy(
            Object.assign(new Error('Preview request timed out'), { code: 'ETIMEDOUT' })
          ),
        CHAT_PREVIEW_NETWORK_TIMEOUT_MS
      )
      timer.unref()
      request.end()
      try {
        return await pending.promise
      } catch (error) {
        clearTimeout(timer)
        options.signal.throwIfAborted()
        if (
          index === targets.length - 1 ||
          !(error instanceof Error) ||
          !('code' in error) ||
          typeof error.code !== 'string' ||
          CONNECTION_FAILURE_CODES[error.code] !== true
        ) {
          throw error
        }
      }
    }
    throw new Error('Preview host has no usable address')
  } catch (error) {
    closeCount()
    throw error
  }
}

export async function openPreviewNetworkResponse(
  source: URL,
  options: {
    allowPrivateNetwork: boolean
    signal: AbortSignal
    budget: PreviewNetworkBudget
    range?: string
    media?: boolean
  }
): Promise<PreviewNetworkResponse> {
  let url = parsePreviewNetworkUrl(source.href)
  for (let redirects = 0; redirects <= CHAT_PREVIEW_MAX_REDIRECTS; redirects++) {
    const result = await requestPinned(url, options)
    const { response } = result
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location
      result.close()
      if (!location || redirects === CHAT_PREVIEW_MAX_REDIRECTS) {
        throw new Error('Preview redirect limit reached or redirect has no address')
      }
      // Each hop must remain credential-free HTTP(S), and gets a fresh all-answer DNS check.
      url = parsePreviewNetworkUrl(new URL(location, url).href)
      continue
    }
    if (response.statusCode !== 200 && response.statusCode !== 206) {
      result.close()
      throw new Error(`Preview server returned HTTP ${response.statusCode}`)
    }
    const encoding = response.headers['content-encoding']
    if (encoding && encoding.toLowerCase() !== 'identity') {
      result.close()
      throw new Error('Compressed preview responses are not supported')
    }
    return result
  }
  throw new Error('Preview redirect limit reached')
}
