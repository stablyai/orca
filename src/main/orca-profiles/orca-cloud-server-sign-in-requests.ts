import type { OrcaAccountMachinePlatform } from '../../shared/orca-account-server-sign-in'
import type { OrcaCloudAuthConfig } from './cloud-auth/profile-cloud-auth-config'

const REQUEST_TIMEOUT_MS = 15_000
const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const POLL_STATES = ['pending', 'denied', 'expired'] as const

/** What the host proves it holds; the PKCE verifier and `state` never leave it. */
export type ServerSignInRequestBody = {
  clientId: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  state: string
  nonce: string
  scope: string
  machineLabel: string
  machinePlatform: OrcaAccountMachinePlatform
  localProfileId: string
}

/** What the approval page shows before it moves the host to another account; an older cloud takes none. */
export type ServerSignInMoveContext = {
  previousUserId?: string
  previousEmail?: string
  linkOwnerUserIds?: string[]
  linkedBotNames?: string[]
}

/** `claimToken` is a bearer secret for this request: it stays in the host process and is never logged. */
export type ServerSignInRequest = {
  requestId: string
  claimToken: string
  userCode: string
  verificationUrl: string
  intervalSeconds: number
  expiresInSeconds: number
}

export type ServerSignInPollResult =
  | { status: 'pending' | 'denied' | 'expired' }
  /** `intervalSeconds` is the slower pace Orca Cloud asks for, when it says. */
  | { status: 'slow_down'; intervalSeconds?: number }
  /** `redirectUri` is passed to the exchange verbatim; the host never builds it. */
  | { status: 'approved'; code: string; redirectUri: string }

/** Network trouble or a 5xx: worth asking again until the request expires. */
export class ServerSignInRequestRetryableError extends Error {}

export class ServerSignInRequestUnsupportedError extends Error {
  constructor() {
    super("Orca Cloud doesn't support server sign-in yet.")
  }
}

export async function startServerSignInRequest(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  body: ServerSignInRequestBody,
  signal: AbortSignal,
  move?: ServerSignInMoveContext
): Promise<ServerSignInRequest> {
  let { status, json } = await post(
    config,
    '/v1/server-sign-in/requests',
    move ? { ...body, ...move } : body,
    signal
  )
  // An older Orca Cloud refuses fields it doesn't know; its page then shows no move warning.
  if (status === 400 && move) {
    ;({ status, json } = await post(config, '/v1/server-sign-in/requests', body, signal))
  }
  if (status === 404) {
    throw new ServerSignInRequestUnsupportedError()
  }
  if (status !== 200 && status !== 201) {
    throw new Error(`Orca Cloud didn't start the sign-in (${status}). Try again.`)
  }
  return parseRequest(json)
}

export async function pollServerSignInRequest(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  request: Pick<ServerSignInRequest, 'requestId' | 'claimToken'>,
  signal: AbortSignal
): Promise<ServerSignInPollResult> {
  const { status, json } = await post(
    config,
    '/v1/server-sign-in/requests/poll',
    { requestId: request.requestId, claimToken: request.claimToken },
    signal
  )
  if (status === 404) {
    // A wrong claim token or a request the cloud no longer has; asking again cannot fix either.
    throw new Error('Orca Cloud no longer knows this sign-in. Start again.')
  }
  const parsed = status === 200 ? parsePoll(json) : null
  if (parsed) {
    return parsed
  }
  throw new Error(`Orca Cloud answered ${status} while waiting for approval. Start again.`)
}

/**
 * Tells Orca Cloud a request is over (cancelled here, or replaced by a newer one), so its page says
 * so. Best effort: an older cloud without the route, or no network, leaves the request to expire.
 */
export async function closeServerSignInRequest(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  request: Pick<ServerSignInRequest, 'requestId' | 'claimToken'>
): Promise<void> {
  await post(
    config,
    '/v1/server-sign-in/requests/close',
    { requestId: request.requestId, claimToken: request.claimToken },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  ).catch(() => undefined)
}

async function post(
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  path: string,
  body: unknown,
  signal: AbortSignal
): Promise<{ status: number; json: unknown }> {
  let response: Response
  try {
    response = await fetch(new URL(path, `${config.apiBaseUrl}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // The body carries the claim token; a redirect must never resend it somewhere else.
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    // The cause can carry request details; only a fixed message leaves this function.
    throw new ServerSignInRequestRetryableError("Couldn't reach Orca Cloud.")
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Orca Cloud redirected the sign-in request. Start again.')
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {})
    throw new ServerSignInRequestRetryableError(`Orca Cloud answered ${response.status}.`)
  }
  const json: unknown = await response.json().catch(() => null)
  return { status: response.status, json }
}

function parseRequest(value: unknown): ServerSignInRequest {
  const record = isRecord(value) ? value : {}
  const text = (key: string): string => {
    const field = record[key]
    if (typeof field !== 'string' || field.length === 0) {
      throw new Error(`Orca Cloud sent a sign-in request without ${key}.`)
    }
    return field
  }
  const seconds = (key: string): number => {
    const field = record[key]
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) {
      throw new Error(`Orca Cloud sent a sign-in request without ${key}.`)
    }
    return field
  }
  const userCode = text('userCode')
  // Printed in a terminal, so only the expected printable shape is accepted.
  if (!USER_CODE_PATTERN.test(userCode)) {
    throw new Error('Orca Cloud sent a sign-in code in an unexpected format. Start again.')
  }
  return {
    requestId: text('requestId'),
    claimToken: text('claimToken'),
    userCode,
    verificationUrl: canonicalLink(text('verificationUrl')),
    intervalSeconds: seconds('intervalSeconds'),
    expiresInSeconds: seconds('expiresInSeconds')
  }
}

// URL parsing drops control characters the terminal would still receive from the raw string.
function canonicalLink(raw: string): string {
  let url: URL | null = null
  try {
    url = /[\s\p{Cc}]/u.test(raw) ? null : new URL(raw)
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('Orca Cloud sent a sign-in link Orca cannot show. Start again.')
  }
  return url.href
}

function parsePoll(value: unknown): ServerSignInPollResult | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.status === 'approved') {
    return typeof value.code === 'string' &&
      value.code.length > 0 &&
      typeof value.redirectUri === 'string' &&
      value.redirectUri.length > 0
      ? { status: 'approved', code: value.code, redirectUri: value.redirectUri }
      : null
  }
  if (value.status === 'slow_down') {
    const interval = value.intervalSeconds
    return typeof interval === 'number' && Number.isFinite(interval) && interval > 0
      ? { status: 'slow_down', intervalSeconds: interval }
      : { status: 'slow_down' }
  }
  const state = POLL_STATES.find((candidate) => candidate === value.status)
  return state ? { status: state } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
