import { parseUsageRetryAfterMs } from './usage-retry-after'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import {
  parseOpenCodeGoUsageApiPayload,
  type OpenCodeGoUsageWindows
} from './opencode-go-status-parsing'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'
import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

export const OPENCODE_GO_USAGE_API_URL = 'https://opencode.ai/zen/go/v1/usage'
const API_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_CHARS = 4_000

/** Unauthorized/no-subscription are definitive key verdicts; failed means no usable answer. */
export type OpenCodeGoUsageApiOutcome =
  | { kind: 'ok'; windows: OpenCodeGoUsageWindows }
  | { kind: 'unauthorized' }
  | { kind: 'no-subscription' }
  | { kind: 'failed'; message: string; failureKind?: UsageRateLimitFailureKind; retryAtMs?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readErrorType(body: string): string | null {
  if (!body || body.length > MAX_ERROR_BODY_CHARS) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return null
    }
    const type = parsed.error.type
    return typeof type === 'string' ? type : null
  } catch {
    return null
  }
}

function classifyFailure(status: number, body: string): OpenCodeGoUsageApiOutcome {
  const errorType = readErrorType(body)
  // Migrated requests reach a new console with different status codes; error names remain stable.
  if (errorType === 'EntitlementError' || status === 403) {
    return { kind: 'no-subscription' }
  }
  if (errorType === 'AuthError' || status === 401) {
    return { kind: 'unauthorized' }
  }
  return { kind: 'failed', message: `OpenCode Go usage request failed (${status})` }
}

/** Fetch via the default Electron session for app-wide proxy handling; the key stays in Authorization, never logs/results/telemetry. */
export async function fetchOpenCodeGoUsageWithApiKey(
  apiKey: string,
  signal?: AbortSignal,
  observeWindows?: (complete: boolean) => void
): Promise<OpenCodeGoUsageApiOutcome> {
  await ensureElectronProxyFromEnvironment({
    probeUrl: OPENCODE_GO_USAGE_API_URL
  }).catch(() => {})

  let response: Response
  try {
    response = await getMainHttpClient().fetch(OPENCODE_GO_USAGE_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
    })
  } catch (error) {
    // Exception messages may embed the authenticated request; return a fixed prefix.
    return {
      kind: 'failed',
      message: `OpenCode Go usage request failed (${error instanceof Error ? error.name : 'network error'})`,
      failureKind: classifyThrownUsageRequestError(error)
    }
  }

  const body = await response.text().catch(() => '')
  if (!response.ok) {
    const failure = classifyFailure(response.status, body)
    const retryAfter =
      response.status === 429 ? parseUsageRetryAfterMs(response.headers.get('retry-after')) : null
    return failure.kind === 'failed' && retryAfter
      ? { ...failure, retryAtMs: Date.now() + retryAfter }
      : failure
  }
  if (observeWindows) {
    try {
      const raw = JSON.parse(body).usage
      const windows = [raw?.rolling, raw?.weekly, ...(raw?.monthly ? [raw.monthly] : [])]
      observeWindows(
        windows.every(
          (window) =>
            typeof window?.percent === 'number' &&
            Number.isFinite(window.percent) &&
            window.percent >= 0 &&
            window.percent <= 100 &&
            (window.resetsAt == null ||
              (typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt))))
        )
      )
    } catch {
      observeWindows(false)
    }
  }
  const windows = parseOpenCodeGoUsageApiPayload(body)
  if (!windows) {
    // Redirected sign-in pages can arrive as successful HTML responses.
    if (response.headers.get('content-type')?.includes('text/html')) {
      return { kind: 'unauthorized' }
    }
    return { kind: 'failed', message: 'Could not parse OpenCode Go usage response' }
  }
  return { kind: 'ok', windows }
}
