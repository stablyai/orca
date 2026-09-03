import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { exchangeOrcaCloudAuthCode } from './profile-cloud-client'
import {
  OrcaCloudTransportError,
  orcaCloudFetch,
  type OrcaCloudTransportFailure
} from './profile-cloud-transport'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  session: { defaultSession: {} }
}))

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue({ source: 'none' })
}))

function configFor(sessionEndpoint: string): OrcaCloudAuthConfig {
  return {
    apiBaseUrl: 'https://orca-cloud.example',
    authorizeEndpoint: 'https://orca-cloud.example/v1/desktop/auth/authorize',
    sessionEndpoint,
    refreshEndpoint: 'https://orca-cloud.example/v1/desktop/auth/refresh',
    capabilitiesEndpoint: 'https://orca-cloud.example/v1/desktop/auth/capabilities',
    profileEndpoint: 'https://orca-cloud.example/v1/desktop/auth/profile',
    orgEndpoint: 'https://orca-cloud.example/v1/desktop/auth/org',
    logoutEndpoint: 'https://orca-cloud.example/v1/desktop/auth/logout',
    relayTokenEndpoint: 'https://orca-cloud.example/v1/desktop/auth/relay-token',
    relayDirectorUrl: 'https://relay.example',
    clientId: 'desktop-client',
    scope: 'openid profile email offline_access'
  }
}

function undiciError(message: string, code?: string): TypeError {
  const inner = new Error(message)
  if (code) {
    Object.assign(inner, { code })
  }
  return new TypeError('fetch failed', { cause: inner })
}

describe('Orca cloud transport failure reporting', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  // Why afterEach and not inline: a failed assertion would otherwise leave the
  // global fetch stub installed for the live-socket suite below.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const cases: { label: string; error: unknown; failure: OrcaCloudTransportFailure }[] = [
    {
      label: 'undici DNS lookup failure',
      error: undiciError('getaddrinfo ENOTFOUND login.onorca.dev', 'ENOTFOUND'),
      failure: 'dns'
    },
    {
      label: 'undici socket close mid-exchange',
      error: undiciError('other side closed', 'UND_ERR_SOCKET'),
      failure: 'connection-lost'
    },
    {
      label: 'undici redirect refusal',
      error: undiciError('unexpected redirect'),
      failure: 'redirect'
    },
    {
      // Verbatim from Electron's net.fetch with redirect: 'error'.
      label: 'Chromium redirect refusal',
      error: new Error("Attempted to redirect, but redirect policy was 'error'"),
      failure: 'redirect'
    },
    {
      // What Electron actually reports when the peer kills the socket.
      label: 'Chromium empty response after socket death',
      error: new Error('net::ERR_EMPTY_RESPONSE'),
      failure: 'connection-lost'
    },
    {
      label: 'Chromium name resolution failure',
      error: new Error('net::ERR_NAME_NOT_RESOLVED'),
      failure: 'dns'
    },
    {
      label: 'intercepted TLS chain',
      error: new Error('net::ERR_CERT_AUTHORITY_INVALID'),
      failure: 'tls'
    },
    {
      label: 'self-signed certificate from undici',
      error: undiciError(
        'self-signed certificate in certificate chain',
        'SELF_SIGNED_CERT_IN_CHAIN'
      ),
      failure: 'tls'
    },
    {
      // Node reports these without an err_ prefix; a skewed clock makes the
      // expiry case common, and it used to fall through to 'unknown'.
      label: 'expired certificate from a skewed clock',
      error: undiciError('certificate has expired', 'CERT_HAS_EXPIRED'),
      failure: 'tls'
    },
    {
      label: 'revoked certificate',
      error: undiciError('certificate revoked', 'CERT_REVOKED'),
      failure: 'tls'
    },
    {
      label: 'proxy tunnel refusal',
      error: new Error('net::ERR_TUNNEL_CONNECTION_FAILED'),
      failure: 'proxy'
    },
    {
      label: 'disconnected network',
      error: new Error('net::ERR_INTERNET_DISCONNECTED'),
      failure: 'offline'
    },
    {
      label: 'connection reset',
      error: new Error('net::ERR_CONNECTION_RESET'),
      failure: 'connection-lost'
    },
    {
      label: 'request timeout signal',
      error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      failure: 'timeout'
    },
    {
      // The only abort these requests carry is the 30s timeout signal.
      label: 'Chromium abort from the timeout signal',
      error: new Error('net::ERR_ABORTED'),
      failure: 'timeout'
    },
    {
      label: 'unreachable address',
      error: new Error('net::ERR_ADDRESS_UNREACHABLE'),
      failure: 'offline'
    },
    {
      label: 'unrecognized transport failure',
      error: new Error('net::ERR_FAILED'),
      failure: 'unknown'
    }
  ]

  for (const { label, error, failure } of cases) {
    it(`classifies ${label} as ${failure}`, async () => {
      fetchMock.mockRejectedValue(error)

      const thrown = await orcaCloudFetch('https://login.onorca.dev/v1/desktop/auth/session', {
        method: 'POST'
      }).catch((caught: unknown) => caught)

      expect(thrown).toBeInstanceOf(OrcaCloudTransportError)
      expect((thrown as OrcaCloudTransportError).failure).toBe(failure)
      // The original chain stays attached for logs even though the message is bounded.
      expect((thrown as OrcaCloudTransportError).cause).toBe(error)
    })
  }

  it('routes cloud requests through the Electron network stack, not global fetch', async () => {
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })

    await orcaCloudFetch('https://login.onorca.dev/v1/desktop/auth/x', { method: 'POST' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  // Verified against real Electron: net.fetch attaches default-session cookies
  // unless credentials is 'omit'. Dropping this would silently start sending
  // app cookies to token endpoints, which the previous undici path never did.
  it('keeps ambient session cookies and cached responses off token endpoints', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })

    await orcaCloudFetch('https://login.onorca.dev/v1/desktop/auth/session', { method: 'POST' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.onorca.dev/v1/desktop/auth/session',
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
    )
  })

  it('forwards the caller timeout signal', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const signal = AbortSignal.timeout(30_000)

    await orcaCloudFetch('https://login.onorca.dev/v1/desktop/auth/session', {
      method: 'POST',
      signal
    })

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }))
  })

  // The two invariants that keep tokens from reaching another origin are
  // enforced by the transport, not by call-site convention.
  it('refuses to let a caller follow redirects or attach session cookies', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })

    await orcaCloudFetch('https://login.onorca.dev/v1/desktop/auth/session', {
      method: 'POST',
      redirect: 'follow',
      credentials: 'include'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error', credentials: 'omit' })
    )
  })
})

// orca#10758: the shipped build reported every one of these as bare
// "fetch failed". This drives the production exchange against a real socket
// that dies mid-request, so the assertion covers the actual transport error
// chain rather than a hand-built stand-in.
describe('Orca cloud session exchange against a failing socket', () => {
  let server: Server
  let sessionEndpoint = ''

  beforeEach(async () => {
    fetchMock.mockReset()
    // Delegate to the real HTTP stack so undici produces a genuine failure.
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      globalThis.fetch(url, init as RequestInit)
    )
    server = createServer((_request, response) => {
      response.socket?.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('loopback_listen_failed')
    }
    sessionEndpoint = `http://127.0.0.1:${address.port}/v1/desktop/auth/session`
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reports a bounded category and never echoes the authorization code', async () => {
    const thrown = await exchangeOrcaCloudAuthCode(configFor(sessionEndpoint), {
      code: 'secret-authorization-code',
      codeVerifier: 'secret-code-verifier',
      nonce: 'secret-nonce',
      redirectUri: 'http://127.0.0.1:4100/auth/callback',
      state: 'secret-state',
      localProfileId: 'local-default'
    }).catch((caught: unknown) => caught)

    expect(thrown).toBeInstanceOf(OrcaCloudTransportError)
    const error = thrown as OrcaCloudTransportError
    expect(error.failure).toBe('connection-lost')
    expect(error.message).not.toBe('fetch failed')
    expect(error.message).toContain('Could not reach Orca Cloud')
    expect(error.message).toContain('the connection closed before a response arrived')
    for (const secret of [
      'secret-authorization-code',
      'secret-code-verifier',
      'secret-nonce',
      'secret-state'
    ]) {
      expect(error.message).not.toContain(secret)
    }
  })
})
