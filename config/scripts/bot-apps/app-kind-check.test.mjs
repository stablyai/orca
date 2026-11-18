import { describe, expect, it } from 'vitest'
import { checkApp } from './app-kind-check.mjs'
import { createGuardedClient } from './guarded-request.mjs'

const MCP = 'https://mcp.example.com/mcp'
const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
const AS_DOC = 'https://auth.example.com/.well-known/oauth-authorization-server'
const OIDC_DOC = 'https://auth.example.com/.well-known/openid-configuration'

const PUBLIC_DNS = { 'mcp.example.com': ['93.184.216.34'], 'auth.example.com': ['93.184.216.35'] }

const goodResource = {
  resource: MCP,
  authorization_servers: ['https://auth.example.com']
}
const goodServer = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256']
}
const challenge = { 'www-authenticate': `Bearer resource_metadata="${PRM}"` }

function json(body, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }
}

function signInRoutes(overrides = {}) {
  return {
    [`POST ${MCP}`]: { status: 401, headers: challenge, body: '' },
    [`GET ${PRM}`]: json(goodResource),
    [`GET ${AS_DOC}`]: json(goodServer),
    ...overrides
  }
}

async function* chunks(...parts) {
  for (const part of parts) {
    yield Buffer.from(part)
  }
}

async function* stalls() {
  yield Buffer.from('{')
  await new Promise(() => {})
}

function fakeNetwork(routes, dns = PUBLIC_DNS) {
  const seen = []
  const transport = async ({ url, method, headers, body }) => {
    seen.push({ method, url: url.href, headers, body })
    const route = routes[`${method} ${url.href}`]
    const reply = typeof route === 'function' ? route(JSON.parse(body ?? 'null')) : route
    if (!reply) {
      return { status: 404, headers: {}, body: chunks('') }
    }
    const replyBody = typeof reply.body === 'string' ? chunks(reply.body) : reply.body
    return { status: reply.status, headers: reply.headers ?? {}, body: replyBody }
  }
  const resolveHost = async (host) => dns[host] ?? []
  return { seen, transport, resolveHost }
}

async function run(app, routes, { dns, ...limits } = {}) {
  const network = fakeNetwork(routes, dns)
  const client = createGuardedClient({
    postUrl: app.url,
    transport: network.transport,
    resolveHost: network.resolveHost,
    timeoutMs: 200,
    ...limits
  })
  return { result: await checkApp(app, client), seen: network.seen }
}

const signInApp = { id: 'acme', url: MCP, signIn: 'browser' }
const openApp = { id: 'docs', url: MCP, signIn: 'none' }

describe('sign-in apps', () => {
  it('passes a 401 Bearer challenge with valid resource and server metadata', async () => {
    const { result, seen } = await run(signInApp, signInRoutes())
    expect(result).toMatchObject({ ok: true })
    expect(seen.filter((request) => request.method === 'POST').map((r) => r.url)).toEqual([MCP])
    expect(seen.some((request) => 'authorization' in request.headers)).toBe(false)
  })

  it('finds the metadata at the well-known path when the challenge names none', async () => {
    const routes = signInRoutes({
      [`POST ${MCP}`]: { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: '' }
    })
    expect((await run(signInApp, routes)).result.ok).toBe(true)
  })

  it('moves on to the next authorization server when the first one is broken', async () => {
    const routes = signInRoutes({
      [`GET ${PRM}`]: json({
        ...goodResource,
        authorization_servers: ['https://broken.example.com', 'https://auth.example.com']
      }),
      'GET https://broken.example.com/.well-known/oauth-authorization-server': json({ issuer: 'x' })
    })
    const dns = { ...PUBLIC_DNS, 'broken.example.com': ['93.184.216.36'] }
    const { result } = await run(signInApp, routes, { dns })
    expect(result).toMatchObject({ ok: true })
    expect(result.detail).toContain('https://auth.example.com offers')
  })

  it('falls back to OpenID discovery', async () => {
    const routes = signInRoutes({
      [`GET ${AS_DOC}`]: undefined,
      [`GET ${OIDC_DOC}`]: json({
        ...goodServer,
        jwks_uri: 'https://auth.example.com/jwks',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256']
      })
    })
    expect((await run(signInApp, routes)).result.ok).toBe(true)
  })

  it.each([
    ['an unauthenticated 200', { [`POST ${MCP}`]: json({}) }, 'expected 401'],
    [
      'a non-Bearer challenge',
      {
        [`POST ${MCP}`]: {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="x"' },
          body: ''
        }
      },
      'no Bearer'
    ],
    [
      'metadata without resource',
      { [`GET ${PRM}`]: json({ authorization_servers: ['https://auth.example.com'] }) },
      '(resource: '
    ],
    [
      'a sibling-path resource',
      { [`GET ${PRM}`]: json({ ...goodResource, resource: 'https://mcp.example.com/other' }) },
      'does not cover'
    ],
    [
      'a string-valued authorization_servers',
      {
        [`GET ${PRM}`]: json({ ...goodResource, authorization_servers: 'https://auth.example.com' })
      },
      'authorization_servers'
    ],
    [
      'no authorization server',
      { [`GET ${PRM}`]: json({ resource: MCP }) },
      'no authorization server'
    ],
    [
      'a string-valued response_types_supported',
      { [`GET ${AS_DOC}`]: json({ ...goodServer, response_types_supported: 'code' }) },
      'response_types_supported'
    ],
    [
      'no registration endpoint',
      { [`GET ${AS_DOC}`]: json({ ...goodServer, registration_endpoint: undefined }) },
      'registration_endpoint'
    ],
    [
      'no S256',
      { [`GET ${AS_DOC}`]: json({ ...goodServer, code_challenge_methods_supported: ['plain'] }) },
      'S256'
    ],
    [
      'an issuer that differs from the one asked for',
      { [`GET ${AS_DOC}`]: json({ ...goodServer, issuer: 'https://other.example.com' }) },
      'names issuer https://other.example.com, expected https://auth.example.com'
    ],
    [
      'a plain-http token endpoint',
      {
        [`GET ${AS_DOC}`]: json({ ...goodServer, token_endpoint: 'http://auth.example.com/token' })
      },
      'token_endpoint: http://auth.example.com/token is not https'
    ],
    [
      'a registration endpoint on a private host',
      {
        [`GET ${AS_DOC}`]: json({
          ...goodServer,
          registration_endpoint: 'https://internal.example.com/register'
        })
      },
      'registration_endpoint: internal.example.com resolves to non-public 10.0.0.7'
    ],
    ['no server metadata at all', { [`GET ${AS_DOC}`]: undefined }, 'no metadata'],
    [
      'an oversized metadata body',
      {
        [`GET ${PRM}`]: { status: 200, headers: {}, body: chunks('x'.repeat(600), 'x'.repeat(600)) }
      },
      'body passed 1000 bytes'
    ],
    [
      'a metadata stream that stalls',
      { [`GET ${PRM}`]: { status: 200, headers: {}, body: stalls() } },
      'timed out'
    ],
    [
      'a redirect to a private host',
      {
        [`GET ${PRM}`]: {
          status: 302,
          headers: { location: 'https://internal.example.com/prm' },
          body: ''
        }
      },
      'non-public 10.0.0.7'
    ],
    [
      'a redirect to plain http',
      {
        [`GET ${PRM}`]: {
          status: 301,
          headers: { location: 'http://mcp.example.com/prm' },
          body: ''
        }
      },
      'is not https'
    ],
    [
      'a metadata URL on a private address',
      {
        [`POST ${MCP}`]: {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://169.254.169.254/latest"'
          },
          body: ''
        }
      },
      'non-public 169.254.169.254'
    ]
  ])('fails on %s', async (_name, overrides, reason) => {
    const dns = { ...PUBLIC_DNS, 'internal.example.com': ['10.0.0.7'] }
    const { result } = await run(signInApp, signInRoutes(overrides), { dns, maxBodyBytes: 1000 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(reason)
  })

  it('refuses an app host that resolves to loopback', async () => {
    const { result, seen } = await run(signInApp, signInRoutes(), {
      dns: { 'mcp.example.com': ['127.0.0.1'] }
    })
    expect(result.detail).toBe('mcp.example.com resolves to non-public 127.0.0.1')
    expect(seen).toEqual([])
  })
})

describe('open apps', () => {
  const openRoutes = (overrides = {}) => ({
    [`POST ${MCP}`]: (message) => {
      if (message.method === 'initialize') {
        return json(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 's', version: '1' }
            }
          },
          200,
          { 'mcp-session-id': 'abc' }
        )
      }
      if (message.method === 'tools/list') {
        const reply = {
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: `event: message\ndata: ${JSON.stringify(reply)}\n\n`
        }
      }
      return { status: 202, headers: {}, body: '' }
    },
    ...overrides
  })

  it('passes initialize and tools/list without sign-in', async () => {
    const { result, seen } = await run(openApp, openRoutes())
    expect(result).toMatchObject({ ok: true, detail: 'initialize ok (2025-06-18), 1 tools' })
    expect(seen[2].headers).toMatchObject({
      'mcp-session-id': 'abc',
      'mcp-protocol-version': '2025-06-18'
    })
  })

  it('fails when the server asks for sign-in', async () => {
    const { result } = await run(
      openApp,
      openRoutes({ [`POST ${MCP}`]: { status: 401, headers: challenge, body: '' } })
    )
    expect(result.detail).toBe('initialize answered 401, expected 200 without sign-in')
  })

  it('fails when the server redirects the POST', async () => {
    const redirect = {
      status: 307,
      headers: { location: 'https://elsewhere.example.com/mcp' },
      body: ''
    }
    const { result, seen } = await run(openApp, openRoutes({ [`POST ${MCP}`]: redirect }))
    expect(result.detail).toContain('not followed')
    expect(seen).toHaveLength(1)
  })
})
