import { net, session } from 'electron'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan, type ActiveSpan } from '../observability/tracer'

/**
 * Bounded categories for a cloud request that never reached an HTTP status.
 * Global fetch collapses every one of these into `TypeError: fetch failed`
 * (orca#10758), which left Windows sign-in failures undiagnosable.
 */
export type OrcaCloudTransportFailure =
  | 'dns'
  | 'tls'
  | 'proxy'
  | 'offline'
  | 'timeout'
  | 'redirect'
  | 'connection-lost'
  | 'unknown'

const FAILURE_REASON: Record<OrcaCloudTransportFailure, string> = {
  dns: 'the Orca Cloud hostname could not be resolved',
  tls: 'the TLS handshake failed — a proxy or security tool may be intercepting HTTPS',
  proxy: 'the configured HTTP proxy refused the connection',
  offline: 'this machine has no working network connection',
  timeout: 'Orca Cloud did not respond in time',
  redirect:
    'Orca Cloud redirected the request, and Orca never follows redirects on token endpoints',
  'connection-lost': 'the connection closed before a response arrived',
  unknown: 'the connection failed'
}

export class OrcaCloudTransportError extends Error {
  constructor(
    public readonly failure: OrcaCloudTransportFailure,
    public readonly detail: string,
    options?: { cause?: unknown }
  ) {
    super(`Could not reach Orca Cloud: ${FAILURE_REASON[failure]} (${detail})`, options)
    this.name = 'OrcaCloudTransportError'
  }
}

// `details` holds one `code: message` string per chain level, so the reported
// detail never pairs an outer error's code with an inner error's message.
type ErrorFacts = { names: string[]; details: string[]; haystack: string }

type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }

// Structural, not `instanceof Error`: DOMException timeouts and Chromium's
// rejection objects both carry name/message without a stable prototype here.
function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null && ('message' in value || 'name' in value)
}

// Undici nests the real error one or two `cause` levels down; Chromium reports
// `net::ERR_*` in the message. Both chains are walked so classification does
// not depend on which transport produced the failure.
function collectErrorFacts(error: unknown): ErrorFacts {
  const names: string[] = []
  const details: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && isErrorLike(current); depth += 1) {
    const name = typeof current.name === 'string' ? current.name : ''
    const message = typeof current.message === 'string' ? current.message : ''
    const code = typeof current.code === 'string' ? current.code : ''
    if (name) {
      names.push(name)
    }
    const detail = [code, message].filter(Boolean).join(': ')
    if (detail) {
      details.push(detail)
    }
    current = current.cause
  }
  return { names, details, haystack: details.join(' | ').toLowerCase() }
}

function classifyTransportFailure(facts: ErrorFacts): OrcaCloudTransportFailure {
  const matches = (pattern: RegExp): boolean => pattern.test(facts.haystack)

  // Why err_aborted counts as a timeout: the only abort signal these requests
  // carry is the 30s AbortSignal.timeout, which Chromium surfaces that way.
  if (facts.names.includes('TimeoutError') || facts.names.includes('AbortError')) {
    return 'timeout'
  }
  if (
    matches(
      /etimedout|und_err_(connect_|headers_|body_)?timeout|err_(connection_)?timed_out|err_aborted/
    )
  ) {
    return 'timeout'
  }
  if (matches(/unexpected redirect|redirect (mode|policy|count)|err_(unsafe_|too_many_)redirect/)) {
    return 'redirect'
  }
  // DNS is checked before TLS so a hostname containing "cert" cannot be
  // mistaken for a certificate failure.
  if (matches(/enotfound|eai_again|err_name_not_resolved|err_name_resolution_failed/)) {
    return 'dns'
  }
  // Bare `cert`: Node reports CERT_HAS_EXPIRED/CERT_REVOKED/CERT_UNTRUSTED
  // without any err_ prefix, and a skewed clock makes the expiry case common.
  if (matches(/cert|err_ssl|err_tls|self.signed|unable_to_verify|eproto/)) {
    return 'tls'
  }
  if (matches(/err_proxy|err_tunnel_connection_failed|proxy_auth/)) {
    return 'proxy'
  }
  if (
    matches(
      /err_internet_disconnected|err_network_changed|err_address_unreachable|enetunreach|enetdown|ehostunreach/
    )
  ) {
    return 'offline'
  }
  if (
    matches(
      /econnreset|econnrefused|econnaborted|epipe|und_err_socket|err_connection_|err_empty_response|err_socket_not_connected/
    )
  ) {
    return 'connection-lost'
  }
  return 'unknown'
}

function recordTransportFailure(span: ActiveSpan, error: unknown): OrcaCloudTransportError {
  const facts = collectErrorFacts(error)
  const failure = classifyTransportFailure(facts)
  // Transport-level text only (errno, net:: code, host) — never request bodies,
  // so authorization codes, verifiers, nonces, and tokens cannot leak here.
  // Capped because this reaches a toast and the trace file, and nothing
  // upstream promises a short message.
  const detail = (facts.details.at(-1) || String(error)).slice(0, 200)
  span.setAttribute('orcaCloud.transportFailure', failure)
  span.setAttribute('orcaCloud.transportErrorName', facts.names.join(' <- ') || typeof error)
  span.setAttribute('orcaCloud.transportErrorDetail', detail)
  return new OrcaCloudTransportError(failure, detail, { cause: error })
}

/**
 * Issue a first-party Orca Cloud request. Why net.fetch: Chromium's stack uses
 * the OS certificate and proxy configuration and its own socket pool, so the
 * call survives Windows TLS interception and undici's stale keep-alive sockets
 * that global fetch could only report as `fetch failed` (orca#10758).
 */
export async function orcaCloudFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'orcaCloud.request',
    async (span) => {
      const endpoint = new URL(url)
      // Origin + path identify which call failed. The query string is dropped
      // because it is the one part of a URL that could ever carry a secret;
      // these endpoints put codes and tokens in the body or Bearer header.
      span.setAttribute('orcaCloud.endpoint', `${endpoint.origin}${endpoint.pathname}`)
      await ensureElectronProxyFromEnvironment({
        proxySession: session.defaultSession,
        probeUrl: url
      }).catch((error: unknown) => {
        span.addEvent('orcaCloud.proxySetupFailed', {
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        const response = await net.fetch(url, {
          // cache:'no-store' keeps Chromium from serving a stale roster on the
          // one GET route; a caller may override it.
          cache: 'no-store',
          ...init,
          // Set after the spread so no call site can weaken them. Following a
          // redirect would re-send a code verifier or refresh token to another
          // origin, and net.fetch attaches default-session cookies unless told
          // otherwise (verified against Electron) — which undici never did
          // cross-origin. These endpoints authenticate from the body or the
          // Bearer header, so ambient session state has no business on them.
          redirect: 'error',
          credentials: 'omit'
        })
        span.setAttribute('orcaCloud.status', response.status)
        return response
      } catch (error) {
        throw recordTransportFailure(span, error)
      }
    },
    { kind: 'client' }
  )
}
