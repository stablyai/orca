import http from 'node:http'
import https from 'node:https'

const CSRF_HEADER_NAME = 'X-Codeium-Csrf-Token'
const REQUEST_TIMEOUT_MS = 2500
const MAX_RESPONSE_BYTES = 1024 * 1024

export function requestAntigravityLocalQuota(options: {
  port: number
  path: string
  csrfToken: string
  isHttps: boolean
  signal?: AbortSignal
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const transport = options.isHttps ? https : http
    const req = transport.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER_NAME]: options.csrfToken
        },
        timeout: REQUEST_TIMEOUT_MS,
        ...(options.isHttps ? { rejectUnauthorized: false } : {}),
        agent: false,
        signal: options.signal
      },
      (res) => {
        let buffer = ''
        let bytes = 0
        res.on('error', reject)
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Quota response too large'))
            return
          }
          buffer += chunk
        })
        res.on('end', () => {
          try {
            const body: unknown = JSON.parse(buffer)
            resolve({ status: res.statusCode ?? 500, body })
          } catch {
            resolve({ status: res.statusCode ?? 500, body: null })
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'))
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.write('{}')
    req.end()
  })
}
