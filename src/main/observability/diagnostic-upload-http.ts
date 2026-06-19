import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

export const MAX_RESPONSE_BYTES = 1024 * 1024

export function postJsonForJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  return postRaw(
    url,
    JSON.stringify(body),
    {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    timeoutMs
  )
}

export function postBodyForJson({
  url,
  body,
  headers,
  timeoutMs
}: {
  readonly url: string
  readonly body: string
  readonly headers: Record<string, string>
  readonly timeoutMs: number
}): Promise<unknown> {
  return postRaw(url, body, { ...headers, accept: 'application/json' }, timeoutMs)
}

function postRaw(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    let req: ClientRequest | null = null
    let res: IncomingMessage | null = null
    const chunks: Buffer[] = []
    let responseBytes = 0
    function cleanupListeners(): void {
      req?.off('error', onRequestError)
      req?.off('timeout', onRequestTimeout)
      res?.off('data', onResponseData)
      res?.off('end', onResponseEnd)
      res?.off('error', onResponseError)
    }
    function resolveOnce(value: unknown): void {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      resolve(value)
    }
    function rejectOnce(
      error: Error,
      options: { destroyRequest?: boolean; destroyResponse?: boolean } = {}
    ): void {
      if (settled) {
        return
      }
      settled = true
      if (options.destroyRequest) {
        req?.destroy()
      }
      if (options.destroyResponse) {
        res?.destroy()
      }
      cleanupListeners()
      reject(error)
    }
    function onResponseData(chunk: Buffer): void {
      responseBytes += chunk.length
      if (responseBytes > MAX_RESPONSE_BYTES) {
        // Why: diagnostics endpoints should return tiny JSON envelopes.
        // Cap response buffering so a bad endpoint cannot grow main memory.
        rejectOnce(new Error('diagnostic response exceeded size limit'), {
          destroyRequest: true,
          destroyResponse: true
        })
        return
      }
      chunks.push(chunk)
    }
    function onResponseEnd(): void {
      const status = res?.statusCode ?? 0
      const text = Buffer.concat(chunks).toString('utf8')
      if (status >= 200 && status < 300) {
        try {
          resolveOnce(text.length > 0 ? JSON.parse(text) : {})
        } catch {
          rejectOnce(new Error(`malformed JSON response (HTTP ${status})`))
        }
      } else {
        // Why: this error can cross IPC into renderer toasts. Never
        // include backend response bodies; they may contain infra detail.
        rejectOnce(new Error(`HTTP ${status}`))
      }
    }
    function onResponseError(): void {
      rejectOnce(new Error('diagnostic network request failed'))
    }
    function onRequestError(): void {
      // Why: request errors can include endpoint hostnames. The diagnostics
      // endpoint contract keeps infrastructure details out of renderer IPC.
      rejectOnce(new Error('diagnostic network request failed'))
    }
    function onRequestTimeout(): void {
      rejectOnce(new Error('diagnostic network request timed out'), { destroyRequest: true })
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      rejectOnce(new Error('diagnostic endpoint configuration is invalid'))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      rejectOnce(new Error('diagnostic endpoint must use http(s)'))
      return
    }
    const protocol = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    req = protocol(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (response) => {
        res = response
        res.on('data', onResponseData)
        res.on('end', onResponseEnd)
        res.on('error', onResponseError)
      }
    )
    req.on('error', onRequestError)
    req.on('timeout', onRequestTimeout)
    req.write(body)
    req.end()
  })
}
