import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { isIP } from 'node:net'

export type PinnedEndpoint = { address: string }

function pinnedLookup(endpoints: PinnedEndpoint[]): LookupFunction {
  const addresses = endpoints.map(({ address }) => ({
    address,
    family: isIP(address.split('%')[0]) === 6 ? 6 : 4
  }))
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses)
    } else {
      callback(null, addresses[0].address, addresses[0].family)
    }
  }
}

/** GET that connects only to the pre-validated addresses; URL host keeps Host/SNI, redirects are returned for the caller to re-validate. */
export function fetchWithPinnedAddresses(
  url: string,
  init: RequestInit,
  endpoints: PinnedEndpoint[]
): Promise<Response> {
  const { signal } = init
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = client.get(
      target,
      { agent: false, lookup: pinnedLookup(endpoints), ...(signal ? { signal } : {}) },
      (response) => {
        try {
          resolve(toResponse(response, request))
        } catch (error) {
          response.destroy()
          request.destroy()
          reject(error)
        }
      }
    )
    request.on('error', reject)
  })
}

function toResponse(response: http.IncomingMessage, request: http.ClientRequest): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }
  const status = response.statusCode ?? 0
  if (status >= 300 && status < 400) {
    response.destroy()
    return new Response(null, { headers, status })
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      response.on('end', () => controller.close())
      response.on('error', (error) => controller.error(error))
    },
    cancel: () => {
      response.destroy()
      request.destroy()
    }
  })
  return new Response([204, 205, 304].includes(status) ? null : body, { headers, status })
}
