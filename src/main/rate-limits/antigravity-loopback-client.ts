import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { parseAntigravityQuotaSummary } from './antigravity-quota-parser'

const LANGUAGE_SERVER_LOG_NAME = 'language_server.log'
const REQUEST_TIMEOUT_MS = 1_250
const MAX_RESPONSE_BYTES = 1024 * 1024
const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'

export type AntigravityLoopbackProtocol = 'http:' | 'https:'

type AntigravityAppConfig = {
  csrfToken: string
  productName: string
}

export type AntigravityServerPorts = {
  http: number | null
  https: number | null
}

/** Marks a request failure that occurred after a loopback service answered. */
export class AntigravityLoopbackResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AntigravityLoopbackResponseError'
  }
}

/** Rejects untrusted log-derived values outside the TCP port range. */
function validPort(value: string | undefined): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

/** Resolves the per-user directory containing Antigravity CLI logs. */
export function getAntigravityCliLogDirectory(homePath: string): string {
  return join(homePath, '.gemini', 'antigravity-cli', 'log')
}

/** Returns the newest HTTP and HTTPS listener announcements in one log. */
export function parseAntigravityCliServerPorts(log: string): AntigravityServerPorts {
  const httpsMatches = [
    ...log.matchAll(/language server listening on (?:random|fixed)(?: port)? at (\d+) for HTTPS/gi)
  ]
  const httpMatches = [
    ...log.matchAll(
      /language server listening on (?:random|fixed)(?: port)? at (\d+) for HTTP(?!S)/gi
    )
  ]
  return {
    http: validPort(httpMatches.at(-1)?.[1]),
    https: validPort(httpsMatches.at(-1)?.[1])
  }
}

/** Resolves the Antigravity desktop language-server log for the host OS. */
export function getAntigravityLanguageServerLogPath(
  platform: NodeJS.Platform,
  homePath: string,
  appDataPath: string
): string {
  return platform === 'darwin'
    ? join(homePath, 'Library', 'Logs', 'Antigravity', LANGUAGE_SERVER_LOG_NAME)
    : join(appDataPath, 'Antigravity', 'logs', LANGUAGE_SERVER_LOG_NAME)
}

/** Returns the newest desktop HTTPS listener announcement. */
export function parseAntigravityLanguageServerPort(log: string): number | null {
  return parseAntigravityCliServerPorts(log).https
}

/** Extracts the assigned JSON object without depending on surrounding script formatting. */
function extractAppConfigJson(html: string): string | null {
  const assignment = /window\.__APP_CONFIG__\s*=\s*/.exec(html)
  if (!assignment) {
    return null
  }
  const start = assignment.index + assignment[0].length
  if (html[start] !== '{') {
    return null
  }
  const scriptEndPattern = /<\/script\s*>/gi
  scriptEndPattern.lastIndex = start
  const end = scriptEndPattern.exec(html)?.index ?? html.length
  let depth = 0
  let escaped = false
  let inString = false

  for (let index = start; index < end; index += 1) {
    const character = html[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return html.slice(start, index + 1)
      }
      if (depth < 0) {
        return null
      }
    }
  }
  return null
}

/** Accepts CSRF configuration only from a page identifying Antigravity. */
export function parseAntigravityAppConfig(html: string): AntigravityAppConfig | null {
  const configJson = extractAppConfigJson(html)
  if (!configJson) {
    return null
  }
  try {
    const config = JSON.parse(configJson) as Record<string, unknown>
    return config.productName === 'antigravity' &&
      typeof config.csrfToken === 'string' &&
      config.csrfToken.length > 0
      ? { productName: config.productName, csrfToken: config.csrfToken }
      : null
  } catch {
    return null
  }
}

/** Sends a bounded request to a fixed loopback host. */
export function requestAntigravityLoopbackPage(
  protocol: AntigravityLoopbackProtocol,
  port: number,
  path: string,
  signal: AbortSignal,
  options?: { body?: string; csrfToken?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    let responseStarted = false
    const body = options?.body
    const headers: Record<string, string | number> = { Connection: 'close' }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
      headers['Connect-Protocol-Version'] = '1'
    }
    if (options?.csrfToken) {
      headers['x-codeium-csrf-token'] = options.csrfToken
    }

    // Why: older AGY servers use self-signed HTTPS. The exception is fixed to
    // loopback so it cannot weaken certificate checks for a network request.
    const request = protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      {
        protocol,
        hostname: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers,
        rejectUnauthorized: protocol === 'https:' ? false : undefined,
        signal,
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        responseStarted = true
        const chunks: Buffer[] = []
        let byteLength = 0
        response.on('data', (chunk: Buffer) => {
          byteLength += chunk.length
          if (byteLength > MAX_RESPONSE_BYTES) {
            req.destroy(
              new AntigravityLoopbackResponseError('Antigravity quota response exceeded size limit')
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(
              new AntigravityLoopbackResponseError(
                `Antigravity quota request failed (${response.statusCode ?? 'unknown'})`
              )
            )
            return
          }
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        response.on('error', (error) => {
          reject(
            new AntigravityLoopbackResponseError(
              `Antigravity quota response ended unexpectedly: ${error.message}`
            )
          )
        })
      }
    )
    req.on('timeout', () =>
      req.destroy(
        responseStarted
          ? new AntigravityLoopbackResponseError('Antigravity quota response timed out')
          : new Error('Antigravity quota request timed out')
      )
    )
    req.on('error', (error) => {
      if (
        responseStarted &&
        !signal.aborted &&
        !(error instanceof AntigravityLoopbackResponseError)
      ) {
        reject(
          new AntigravityLoopbackResponseError(
            `Antigravity quota response failed: ${error.message}`
          )
        )
        return
      }
      reject(error)
    })
    req.end(body)
  })
}

/** Marks loopback data so downstream telemetry cannot mistake it for OAuth usage. */
function withLiveSessionMetadata(limits: ProviderRateLimits): ProviderRateLimits {
  return {
    ...limits,
    usageMetadata: {
      source: 'live-session',
      attemptedSources: ['live-session'],
      credentialSource: 'agy-local-service',
      authProvenance: 'antigravity'
    }
  }
}

/** Fetches and validates one Antigravity quota endpoint response. */
export async function fetchAntigravityQuotaEndpoint(
  protocol: AntigravityLoopbackProtocol,
  port: number,
  signal: AbortSignal,
  csrfToken?: string
): Promise<ProviderRateLimits | null> {
  const response = await requestAntigravityLoopbackPage(
    protocol,
    port,
    QUOTA_SUMMARY_PATH,
    signal,
    { body: '{}', csrfToken }
  )
  let data: unknown
  try {
    data = JSON.parse(response) as unknown
  } catch {
    throw new AntigravityLoopbackResponseError('Antigravity quota response was not valid JSON')
  }
  const parsed = parseAntigravityQuotaSummary(data)
  return parsed ? withLiveSessionMetadata(parsed) : null
}
