import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  createAntigravityLogSource,
  discoverAntigravityLanguageServers,
  type AntigravityLanguageServerEndpoint,
  type AntigravityLogSource
} from './antigravity-language-server-log'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'
import { probeAntigravityQuotaInWsl } from './antigravity-wsl-usage-probe'

const QUOTA_RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 2_500
const MAX_RESPONSE_BYTES = 1024 * 1024

export const ANTIGRAVITY_NOT_RUNNING_REASON =
  'Antigravity usage is not available. Start the Antigravity CLI (agy) so Orca can read its quota.'
export const ANTIGRAVITY_SIGNED_OUT_REASON =
  'Antigravity usage is not available. Sign in with the Antigravity CLI (agy) to see your quota.'
export const ANTIGRAVITY_QUOTA_UNREADABLE_REASON =
  'Antigravity usage is not available. The Antigravity CLI did not report a readable quota.'

export type QuotaSummaryResponse = { statusCode: number; body: string }

export type AntigravityQuotaTransport = (
  target: { scheme: 'http' | 'https'; port: number },
  signal?: AbortSignal
) => Promise<QuotaSummaryResponse>

/**
 * Posts the empty Connect request the LanguageServer expects. The HTTPS port presents a
 * self-signed certificate; that exception is safe only because the request never leaves loopback.
 */
export const requestAntigravityQuotaSummary = (
  target: { scheme: 'http' | 'https'; port: number },
  signal?: AbortSignal,
  requestOverride?: typeof httpRequest
): Promise<QuotaSummaryResponse> =>
  new Promise((resolve, reject) => {
    let settled = false
    let cleanupResponseListeners = (): void => {}
    let cleanupResponseBodyListeners = (): void => {}
    let req: ReturnType<typeof httpRequest>
    const cleanupAbortListener = (): void => signal?.removeEventListener('abort', onAbort)
    const settle = (action: () => void, waitForResponseClose = false): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupAbortListener()
      if (waitForResponseClose) {
        cleanupResponseBodyListeners()
      } else {
        cleanupResponseListeners()
      }
      action()
    }
    const resolveWithCleanup = (response: QuotaSummaryResponse): void => {
      settle(() => resolve(response))
    }
    const rejectWithCleanup = (error: unknown): void => {
      settle(() => reject(error))
    }
    const rejectBeforeResponseClose = (error: unknown): void => {
      settle(() => reject(error), true)
    }
    const onAbort = (): void => {
      req.destroy(new Error('aborted'))
    }
    const send = requestOverride ?? (target.scheme === 'https' ? httpsRequest : httpRequest)
    req = send(
      {
        host: LOOPBACK_HOST,
        port: target.port,
        path: QUOTA_RPC_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
        timeout: REQUEST_TIMEOUT_MS,
        ...(target.scheme === 'https' ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        let body = ''
        let bodyBytes = 0
        res.setEncoding('utf8')
        const onData = (chunk: string): void => {
          if (settled) {
            return
          }
          bodyBytes += Buffer.byteLength(chunk, 'utf8')
          if (bodyBytes > MAX_RESPONSE_BYTES) {
            rejectBeforeResponseClose(new Error('Antigravity quota response too large'))
            req.destroy()
            return
          }
          body += chunk
        }
        const onEnd = (): void => {
          resolveWithCleanup({ statusCode: res.statusCode ?? 0, body })
        }
        const onAborted = (): void => {
          rejectBeforeResponseClose(new Error('Antigravity quota response was aborted'))
        }
        const onError = (error: Error): void => {
          if (settled) {
            cleanupResponseListeners()
            return
          }
          rejectWithCleanup(error)
        }
        const onClose = (): void => {
          if (settled) {
            cleanupResponseListeners()
            return
          }
          rejectWithCleanup(new Error('Antigravity quota response closed before completion'))
        }
        cleanupResponseBodyListeners = (): void => {
          res.removeListener('data', onData)
          res.removeListener('end', onEnd)
          res.removeListener('aborted', onAborted)
        }
        cleanupResponseListeners = (): void => {
          cleanupResponseBodyListeners()
          res.removeListener('error', onError)
          res.removeListener('close', onClose)
        }
        res.on('data', onData)
        res.once('end', onEnd)
        res.once('aborted', onAborted)
        res.once('error', onError)
        res.once('close', onClose)
      }
    )
    req.on('timeout', () => req.destroy(new Error('Antigravity quota request timed out')))
    req.on('error', rejectWithCleanup)
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    req.end('{}')
  })

function unavailable(
  reason: string,
  failureKind: 'cli-unavailable' | 'missing-credentials'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason,
    status: 'unavailable',
    usageMetadata: { source: 'cli', failureKind }
  }
}

function failed(reason: string, failureKind: 'server' | 'parse' | 'network'): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason,
    status: 'error',
    usageMetadata: { source: 'cli', failureKind }
  }
}

/** `agy` answers a signed-out quota call with HTTP 500 and this phrase, not with a 401. */
function isSignedOutResponse(response: QuotaSummaryResponse): boolean {
  return response.statusCode >= 400 && /not logged into antigravity/i.test(response.body)
}

function endpointTargets(
  endpoint: AntigravityLanguageServerEndpoint
): { scheme: 'http' | 'https'; port: number }[] {
  const targets: { scheme: 'http' | 'https'; port: number }[] = []
  // Why: prefer the plaintext port so the common path needs no self-signed TLS exception at all.
  if (endpoint.httpPort !== null) {
    targets.push({ scheme: 'http', port: endpoint.httpPort })
  }
  if (endpoint.httpsPort !== null) {
    targets.push({ scheme: 'https', port: endpoint.httpsPort })
  }
  return targets
}

export type AntigravityUsageFetchOptions = {
  signal?: AbortSignal
  target?: { runtime: 'host' | 'wsl'; wslDistro: string | null }
  logSource?: AntigravityLogSource
  transport?: AntigravityQuotaTransport
}

function providerFromResponse(response: QuotaSummaryResponse): ProviderRateLimits {
  if (isSignedOutResponse(response)) {
    return unavailable(ANTIGRAVITY_SIGNED_OUT_REASON, 'missing-credentials')
  }
  if (response.statusCode !== 200) {
    return failed(`Antigravity quota fetch failed (${response.statusCode})`, 'server')
  }
  let parsed: ReturnType<typeof parseAntigravityQuotaSummary>
  try {
    parsed = parseAntigravityQuotaSummary(JSON.parse(response.body))
  } catch {
    parsed = null
  }
  if (!parsed) {
    return failed(ANTIGRAVITY_QUOTA_UNREADABLE_REASON, 'parse')
  }
  return {
    provider: 'antigravity',
    session: parsed.session,
    weekly: parsed.weekly,
    buckets: parsed.buckets,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}

/**
 * Reads Antigravity quota from the LanguageServer on the selected host or WSL runtime.
 *
 * Why not the Gemini snapshot: the two products bill different pools, and `agy` keeps its token in
 * the OS keyring where no Gemini CLI credential file can describe it (#9122).
 */
export async function fetchAntigravityRateLimits(
  options: AntigravityUsageFetchOptions = {}
): Promise<ProviderRateLimits> {
  if (options.target?.runtime === 'wsl') {
    const result = await probeAntigravityQuotaInWsl(options.target.wslDistro, options.signal)
    if (result.kind === 'not-running') {
      return unavailable(ANTIGRAVITY_NOT_RUNNING_REASON, 'cli-unavailable')
    }
    if (result.kind === 'unverifiable') {
      return failed(result.reason, 'network')
    }
    return providerFromResponse(result)
  }
  const logSource = options.logSource ?? createAntigravityLogSource()
  const transport = options.transport ?? requestAntigravityQuotaSummary
  const endpoints = await discoverAntigravityLanguageServers(logSource)
  if (endpoints.length === 0) {
    return unavailable(ANTIGRAVITY_NOT_RUNNING_REASON, 'cli-unavailable')
  }

  let lastFailure: ProviderRateLimits | null = null
  for (const endpoint of endpoints) {
    for (const target of endpointTargets(endpoint)) {
      if (options.signal?.aborted) {
        return failed('Antigravity quota fetch was cancelled', 'network')
      }
      let response: QuotaSummaryResponse
      try {
        response = await transport(target, options.signal)
      } catch (err) {
        lastFailure = failed(
          err instanceof Error ? err.message : 'Antigravity quota request failed',
          'network'
        )
        continue
      }
      // Why: a signed-out answer is a settled fact about the account, not a transient fault.
      // Falling through to an older `agy` here would resurrect the stale-account bug this
      // ordering exists to prevent — that process still holds the account it started with.
      return providerFromResponse(response)
    }
  }

  return lastFailure ?? unavailable(ANTIGRAVITY_NOT_RUNNING_REASON, 'cli-unavailable')
}
