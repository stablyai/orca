import { protocol } from 'electron'
import { createMediaRangeResponse } from './media-range-response'
import { CHAT_ADDRESS_PREVIEW_SCHEME, getChatPreviewGrant } from './chat-address-preview-grants'
import {
  openPreviewNetworkResponse,
  streamPreviewNetworkResponse,
  CHAT_PREVIEW_MAX_MEDIA_BYTES
} from './chat-address-preview-network'

export const CHAT_PREVIEW_PROTOCOL: Electron.CustomScheme = {
  scheme: CHAT_ADDRESS_PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}

function secureHeaders(response: Response, origin: string): Response {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
  response.headers.set('Access-Control-Allow-Origin', origin)
  return response
}

export async function handleChatAddressPreviewRequest(request: Request): Promise<Response> {
  const grant = getChatPreviewGrant(request.url)
  if (!grant?.resource) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }
  const ownerUrl = new URL(grant.owner.getURL())
  const origin = request.headers.get('origin')
  if (origin && origin !== ownerUrl.origin) {
    return new Response(null, { status: 403 })
  }
  if (request.referrer) {
    try {
      const referrer = new URL(request.referrer)
      if (
        referrer.origin !== ownerUrl.origin ||
        (ownerUrl.protocol === 'file:' && referrer.pathname !== ownerUrl.pathname)
      ) {
        return new Response(null, { status: 403 })
      }
    } catch {
      return new Response(null, { status: 403 })
    }
  }
  if (request.destination && !['image', 'audio', 'video', 'empty'].includes(request.destination)) {
    return new Response(null, { status: 403 })
  }
  if (grant.activeStreams >= 4) {
    return new Response(null, { status: 429 })
  }
  grant.activeStreams++
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    grant.activeStreams--
  }
  const signal = AbortSignal.any([request.signal, grant.controller.signal])
  const scopedRequest = new Request(request, { signal })
  try {
    signal.throwIfAborted()
    const resource = grant.resource
    if (resource.type === 'bytes' || resource.type === 'local') {
      const response = await createMediaRangeResponse(scopedRequest, grant.mimeType, {
        size: resource.type === 'bytes' ? resource.bytes.length : resource.size,
        read: async (offset, length) => {
          signal.throwIfAborted()
          if (resource.type === 'bytes') {
            return resource.bytes.subarray(offset, offset + length)
          }
          const bytes = Buffer.allocUnsafe(length)
          const { bytesRead } = await resource.handle.read(bytes, 0, length, offset)
          signal.throwIfAborted()
          return bytes.subarray(0, bytesRead)
        },
        close: async () => {
          close()
        }
      })
      return secureHeaders(response, ownerUrl.origin)
    }
    const range = request.headers.get('range')
    const requestedRange = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
    if (
      range &&
      (!requestedRange ||
        (!requestedRange[1] && !requestedRange[2]) ||
        requestedRange.slice(1).some((value) => value && !Number.isSafeInteger(Number(value))))
    ) {
      close()
      return new Response(null, { status: 416 })
    }
    if (request.method === 'HEAD' && resource.size !== undefined) {
      close()
      return secureHeaders(
        new Response(null, {
          headers: {
            'Content-Type': grant.mimeType,
            'Content-Length': String(resource.size),
            'Accept-Ranges': 'bytes'
          }
        }),
        ownerUrl.origin
      )
    }
    const result = await openPreviewNetworkResponse(resource.url, {
      signal,
      allowPrivateNetwork: resource.allowPrivateNetwork,
      budget: grant.budget,
      range: range ?? undefined,
      media: true
    })
    const headers = new Headers({ 'Content-Type': grant.mimeType, 'Accept-Ranges': 'bytes' })
    const length = result.response.headers['content-length']
    if (length && (!/^\d+$/.test(length) || Number(length) > CHAT_PREVIEW_MAX_MEDIA_BYTES)) {
      result.close()
      throw new Error('Preview media exceeds the size limit')
    }
    if (length) {
      headers.set('Content-Length', length)
    }
    const contentRange = result.response.headers['content-range']
    if (result.response.statusCode === 206) {
      const match =
        typeof contentRange === 'string' ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange) : null
      const start = match ? Number(match[1]) : -1
      const end = match ? Number(match[2]) : -1
      const total = match && match[3] !== '*' ? Number(match[3]) : undefined
      const requestedStart = requestedRange?.[1] ? Number(requestedRange[1]) : undefined
      const requestedEnd = requestedRange?.[2] ? Number(requestedRange[2]) : undefined
      if (
        !requestedRange ||
        !match ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start ||
        (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) ||
        (requestedStart !== undefined && requestedStart !== start) ||
        (requestedStart !== undefined && requestedEnd !== undefined && end > requestedEnd) ||
        (requestedStart === undefined &&
          (total === undefined || start !== Math.max(0, total - requestedEnd!))) ||
        (length !== undefined && Number(length) !== end - start + 1)
      ) {
        result.close()
        throw new Error('Preview server returned an invalid media range')
      }
      headers.set('Content-Range', contentRange!)
    } else if (range && !range.startsWith('bytes=0-')) {
      result.close()
      close()
      return new Response(null, { status: 416 })
    }
    if (request.method === 'HEAD') {
      result.close()
      close()
      return secureHeaders(new Response(null, { headers }), ownerUrl.origin)
    }
    return secureHeaders(
      new Response(streamPreviewNetworkResponse(result, signal, close), {
        status: result.response.statusCode,
        headers
      }),
      ownerUrl.origin
    )
  } catch {
    close()
    return new Response(null, { status: signal.aborted ? 410 : 502 })
  }
}

export function installChatAddressPreviewProtocolHandler(): void {
  protocol.handle(CHAT_ADDRESS_PREVIEW_SCHEME, handleChatAddressPreviewRequest)
}
