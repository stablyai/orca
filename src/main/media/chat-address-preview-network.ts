import { session } from 'electron'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { parsePreviewNetworkUrl, resolvePreviewAddress } from './chat-address-preview-security'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'

export const CHAT_PREVIEW_MAX_REDIRECTS = 4
export const CHAT_PREVIEW_MAX_NETWORK_REQUESTS = 256
export const CHAT_PREVIEW_NETWORK_TIMEOUT_MS = 30_000
export const CHAT_PREVIEW_MEDIA_TIMEOUT_MS = 5 * 60_000
export const CHAT_PREVIEW_MAX_MEDIA_BYTES = 512 * 1024 * 1024
export type PreviewNetworkBudget = { requests: number }
export type PreviewNetworkResponse = {
  response: IncomingMessage
  url: URL
  close: () => void
}

let activeRequests = 0
const MAX_ACTIVE_REQUESTS = 32

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
    const target = await resolvePreviewAddress(url, options.allowPrivateNetwork, options.signal)
    await assertDirectPreviewPolicy(url, options.signal)
    options.signal.throwIfAborted()
    const pending = Promise.withResolvers<PreviewNetworkResponse>()
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      // A numeric hostname skips DNS in the connector; Host and TLS identity stay original.
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
      closeCount()
      pending.reject(error)
    })
    timer = setTimeout(
      () => request.destroy(new Error('Preview request timed out')),
      options.media ? CHAT_PREVIEW_MEDIA_TIMEOUT_MS : CHAT_PREVIEW_NETWORK_TIMEOUT_MS
    )
    timer.unref()
    request.end()
    return await pending.promise
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

export function previewResponseSize(response: IncomingMessage): number | undefined {
  const contentRange = response.headers['content-range']
  const range =
    typeof contentRange === 'string' ? /^bytes \d+-\d+\/(\d+)$/.exec(contentRange) : null
  const raw =
    range?.[1] ?? (response.statusCode === 200 ? response.headers['content-length'] : undefined)
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return undefined
  }
  const size = Number(raw)
  return Number.isSafeInteger(size) ? size : undefined
}

/** A prefix request stops as soon as enough bytes arrive, even when Range was ignored. */
export async function readPreviewNetworkBytes(
  result: PreviewNetworkResponse,
  limit: number,
  prefix = false
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const value of result.response) {
      const chunk = value as Buffer
      const remaining = limit - total
      if (!prefix && chunk.length > remaining) {
        throw new Error('Preview file exceeds the size limit')
      }
      const bytes = chunk.subarray(0, remaining)
      chunks.push(bytes)
      total += bytes.length
      if (prefix && total >= limit) {
        break
      }
    }
    return Buffer.concat(chunks, total)
  } finally {
    result.close()
  }
}

/** Keep the socket backpressured; media bodies are never materialized in main. */
export function streamPreviewNetworkResponse(
  result: PreviewNetworkResponse,
  signal: AbortSignal,
  onClose: () => void
): ReadableStream<Uint8Array> {
  const iterator = result.response[Symbol.asyncIterator]()
  let total = 0
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    signal.removeEventListener('abort', abort)
    result.close()
    onClose()
  }
  const abort = (): void => {
    if (!closed) {
      controller.error(new Error('Preview cancelled'))
    }
    close()
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
    },
    async pull(value) {
      try {
        const next = await iterator.next()
        if (closed) {
          return
        }
        if (next.done) {
          value.close()
          close()
          return
        }
        total += next.value.length
        if (total > CHAT_PREVIEW_MAX_MEDIA_BYTES) {
          throw new Error('Preview media exceeds the size limit')
        }
        value.enqueue(next.value)
      } catch (error) {
        if (!closed) {
          value.error(error)
        }
        close()
      }
    },
    cancel: close
  })
}
