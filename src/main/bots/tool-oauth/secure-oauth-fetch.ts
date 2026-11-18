// The only way Orca's sign-in code reaches an authorization server. Metadata names the endpoints the
// code, verifier and refresh token are posted to, so every hop is checked here, not just the first.
import { getMainHttpClient } from '../../network/http-client'
import {
  FetchResponseBodyTooLargeError,
  readFetchResponseBytesWithinLimit
} from '../../../shared/network/fetch-response-body'
import {
  hostAddresses,
  isPublicAddress,
  systemAddressLookup,
  type AddressLookup
} from './oauth-endpoint-address'

export type OAuthFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/** A refusal this module made; its message names only an origin, never a URL with a query. */
export class OAuthFetchRefused extends Error {
  constructor(
    readonly code:
      | 'insecure'
      | 'private-endpoint'
      | 'lookup-failed'
      | 'redirect-origin'
      | 'too-many-redirects'
      | 'too-large'
      | 'timeout',
    readonly origin: string
  ) {
    super(`OAuth request to ${origin} refused: ${code}`)
  }
}

// Metadata, a registration and a token set are a few KB; nothing larger is one of them.
const BODY_LIMIT = 1024 * 1024
const REQUEST_DEADLINE_MS = 20_000
const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NO_BODY = new Set([101, 204, 205, 304])

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

/** https, or http to this machine (RFC 8252 §7.3); anything else would put a credential on the wire. */
export const isSecureOAuthEndpoint = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))

export type SecureOAuthFetchOptions = {
  /** The app's MCP address: while it is public, every OAuth endpoint must be public too. */
  resource: string
  signal?: AbortSignal
  lookup?: AddressLookup
  /** The transport underneath; Orca's own HTTP client (and its proxy settings) by default. */
  fetch?: OAuthFetch
  deadlineMs?: number
}

export function secureOAuthFetch(options: SecureOAuthFetchOptions): OAuthFetch {
  const resolve = options.lookup ?? systemAddressLookup
  const send = options.fetch ?? ((url, init) => getMainHttpClient().fetch(String(url), init))
  let resourcePublic: Promise<boolean> | null = null
  const checkAddress = async (url: URL): Promise<void> => {
    resourcePublic ??= hostAddresses(new URL(options.resource), resolve).then(
      (addresses) => addresses.length > 0 && addresses.every(isPublicAddress),
      () => {
        throw new OAuthFetchRefused('lookup-failed', new URL(options.resource).origin)
      }
    )
    // An app the user runs on a private address commonly signs in on that network too.
    if (!(await resourcePublic)) {
      return
    }
    let addresses: readonly string[]
    try {
      addresses = await hostAddresses(url, resolve)
    } catch {
      throw new OAuthFetchRefused('lookup-failed', url.origin)
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new OAuthFetchRefused('private-endpoint', url.origin)
    }
  }
  return async (input, init = {}) => {
    const deadline = AbortSignal.timeout(options.deadlineMs ?? REQUEST_DEADLINE_MS)
    const signal = AbortSignal.any(
      [deadline, options.signal, init.signal ?? undefined].filter((s): s is AbortSignal => !!s)
    )
    let url = new URL(input)
    let request: RequestInit = { ...init }
    for (let hop = 0; ; hop += 1) {
      if (!isSecureOAuthEndpoint(url)) {
        throw new OAuthFetchRefused('insecure', url.origin)
      }
      // A lookup that never answers is bounded like the request it guards.
      await untilAborted(checkAddress(url), signal, () =>
        deadline.aborted ? new OAuthFetchRefused('timeout', url.origin) : signal.reason
      )
      let response: Response
      try {
        response = await send(url, { ...request, redirect: 'manual', signal })
      } catch (error) {
        if (deadline.aborted) {
          throw new OAuthFetchRefused('timeout', url.origin)
        }
        throw error
      }
      if (response.type === 'opaqueredirect' || response.status === 0) {
        // A redirect whose target the transport hides can't be checked, so it isn't followed.
        await response.body?.cancel().catch(() => undefined)
        throw new OAuthFetchRefused('redirect-origin', url.origin)
      }
      const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null
      if (location === null) {
        return await bounded(response, url.origin, deadline)
      }
      await response.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) {
        throw new OAuthFetchRefused('too-many-redirects', url.origin)
      }
      const next = new URL(location, url)
      // A body or Authorization header was meant for this origin only (a code, a secret, a token).
      if (next.origin !== url.origin && carriesCredential(request)) {
        throw new OAuthFetchRefused('redirect-origin', next.origin)
      }
      // RFC 9110 §15.4: 307 and 308 keep the method and body; the others become a bodyless GET.
      if (response.status !== 307 && response.status !== 308) {
        const { body: _body, ...rest } = request
        request = { ...rest, method: 'GET' }
      }
      url = next
    }
  }
}

function carriesCredential(request: RequestInit): boolean {
  return (
    (request.body !== undefined && request.body !== null) ||
    new Headers(request.headers).has('authorization')
  )
}

/** `work`, or a rejection with `reason()` as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, reason: () => unknown): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined)
    return Promise.reject(reason())
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(reason())
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      }
    )
  })
}

/** The response with its whole body read, refusing one past the limit or the deadline. */
async function bounded(response: Response, origin: string, deadline: AbortSignal) {
  let body: Uint8Array
  try {
    body = await readFetchResponseBytesWithinLimit(response, BODY_LIMIT)
  } catch (error) {
    if (error instanceof FetchResponseBodyTooLargeError) {
      throw new OAuthFetchRefused('too-large', origin)
    }
    throw deadline.aborted ? new OAuthFetchRefused('timeout', origin) : error
  }
  const headers = new Headers(response.headers)
  // The body below is the decoded one, so its encoding and length no longer describe it.
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(NO_BODY.has(response.status) ? null : new Uint8Array(body), {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}
