import http from 'node:http'
import https from 'node:https'

export const ANTIGRAVITY_LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 2_500
const MAX_RESPONSE_BYTES = 1_048_576

export function postAntigravityLoopbackQuota(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES
): Promise<unknown> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.resolve(null)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname !== ANTIGRAVITY_LOOPBACK_HOST
  ) {
    return Promise.resolve(null)
  }
  const isHttps = parsed.protocol === 'https:'
  const requestOptions: https.RequestOptions = {
    protocol: parsed.protocol,
    hostname: ANTIGRAVITY_LOOPBACK_HOST,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }
  }
  // Why: Agy presents a self-signed cert on 127.0.0.1 only.
  if (isHttps) {
    requestOptions.rejectUnauthorized = false
  }
  return new Promise((resolve) => {
    let settled = false
    let request: http.ClientRequest | undefined
    const chunks: Buffer[] = []
    let bytes = 0
    const finish = (value: unknown) => {
      if (!settled) {
        settled = true
        clearTimeout(deadline)
        request?.destroy()
        resolve(value)
      }
    }
    const deadline = setTimeout(() => finish(null), timeoutMs)
    request = (isHttps ? https : http).request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > maxBytes) {
          finish(null)
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          finish(null)
          return
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          finish(null)
        }
      })
      response.on('error', () => finish(null))
      response.on('aborted', () => finish(null))
    })
    request.on('error', () => finish(null))
    request.end('{"forceRefresh":true}')
  })
}
