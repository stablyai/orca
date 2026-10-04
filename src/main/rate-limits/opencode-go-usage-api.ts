import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import {
  parseOpenCodeGoUsageApiPayload,
  type OpenCodeGoUsageWindows
} from './opencode-go-status-parsing'

export const OPENCODE_GO_USAGE_API_URL = 'https://opencode.ai/zen/go/v1/usage'
const API_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_CHARS = 4_000

/**
 * Outcome of one Bearer-authenticated usage request.
 *
 * `unauthorized` and `no-subscription` are the server's two definitive verdicts
 * about the key; `failed` covers everything Orca could not get an answer from.
 */
export type OpenCodeGoUsageApiOutcome =
  | { kind: 'ok'; windows: OpenCodeGoUsageWindows }
  | { kind: 'unauthorized' }
  | { kind: 'no-subscription' }
  | { kind: 'failed'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Error type names the console returns; see `routes/zen/go/v1/usage.ts`. */
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
  // Why type-first: a migrated account's request is proxied to the new console,
  // which owns its own status codes; the error name is the stable signal.
  if (errorType === 'EntitlementError' || status === 403) {
    return { kind: 'no-subscription' }
  }
  if (errorType === 'AuthError' || status === 401) {
    return { kind: 'unauthorized' }
  }
  return { kind: 'failed', message: `OpenCode Go usage request failed (${status})` }
}

/**
 * Fetch OpenCode Go usage with the account's API key.
 *
 * Runs on the default Electron session so the app-wide proxy guard covers it.
 * The key is sent only as an `Authorization` header and never reaches a log,
 * a returned message, or telemetry.
 * @param apiKey - The resolved OpenCode Go API key.
 * @param signal - Optional cancellation signal for the enclosing fetch cycle.
 * @returns The parsed usage windows or a classified failure.
 */
export async function fetchOpenCodeGoUsageWithApiKey(
  apiKey: string,
  signal?: AbortSignal
): Promise<OpenCodeGoUsageApiOutcome> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OPENCODE_GO_USAGE_API_URL
  }).catch(() => {})

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  let response: Response
  try {
    response = await net.fetch(OPENCODE_GO_USAGE_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: requestSignal
    })
  } catch (error) {
    // Why fixed prefix: the thrown message can embed the request, and the
    // request carries the key.
    return {
      kind: 'failed',
      message: `OpenCode Go usage request failed (${error instanceof Error ? error.name : 'network error'})`
    }
  }

  const body = await response.text().catch(() => '')
  if (!response.ok) {
    return classifyFailure(response.status, body)
  }
  const windows = parseOpenCodeGoUsageApiPayload(body)
  if (!windows) {
    // Why: Electron follows redirects, so a key bounced to console sign-in arrives as a 200 page.
    if (response.headers.get('content-type')?.includes('text/html')) {
      return { kind: 'unauthorized' }
    }
    return { kind: 'failed', message: 'Could not parse OpenCode Go usage response' }
  }
  return { kind: 'ok', windows }
}
