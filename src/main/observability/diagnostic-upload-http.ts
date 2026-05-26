import { request as httpRequest } from 'node:http'
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
    function resolveOnce(value: unknown): void {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }
    function rejectOnce(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      reject(error)
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
    const req = protocol(
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
      (res) => {
        const chunks: Buffer[] = []
        let responseBytes = 0
        res.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length
          if (responseBytes > MAX_RESPONSE_BYTES) {
            // Why: diagnostics endpoints should return tiny JSON envelopes.
            // Cap response buffering so a bad endpoint cannot grow main memory.
            rejectOnce(new Error('diagnostic response exceeded size limit'))
            req.destroy()
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
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
        })
        res.on('error', () => {
          rejectOnce(new Error('diagnostic network request failed'))
        })
      }
    )
    req.on('error', () => {
      // Why: request errors can include endpoint hostnames. The diagnostics
      // endpoint contract keeps infrastructure details out of renderer IPC.
      rejectOnce(new Error('diagnostic network request failed'))
    })
    req.on('timeout', () => {
      rejectOnce(new Error('diagnostic network request timed out'))
      req.destroy()
    })
    req.write(body)
    req.end()
  })
}
