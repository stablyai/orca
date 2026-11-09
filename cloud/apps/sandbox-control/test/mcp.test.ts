import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { purgeOAuth } from '../src/mcp/oauth'
import { createHarness } from './harness'

const ORIGIN = 'https://sandbox.test'
const REDIRECT = 'http://127.0.0.1:33418/callback'

async function harness(overrides: Record<string, string> = {}) {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({ PUBLIC_API_URL: ORIGIN, ...overrides }, { waitUntil: (p) => void pending.push(p) })
  let rpcId = 0

  async function rpc(bearer: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
    const response = await h.send(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) })
      })
    )
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as any }
  }

  async function tool(bearer: string, name: string, args: Record<string, unknown> = {}) {
    const res = await rpc(bearer, 'tools/call', { name, arguments: args }, { 'mcp-protocol-version': '2025-11-25' })
    expect(res.status).toBe(200)
    return res.body.result as { isError?: boolean; structuredContent: any; content: { text: string }[] }
  }

  async function apiKey(scopes: string[], as = 'alice', org?: { org: string; role: string }) {
    const bearer = org ? await h.token(as, org.org, 'sandbox', { orgRole: org.role }) : await h.token(as)
    const created = await h.call('POST', '/v1/api-keys', { bearer, body: { name: 'mcp', scopes } })
    expect(created.status).toBe(201)
    return created.body.secret as string
  }

  async function register(body: Record<string, unknown> = { client_name: 'Test Client', redirect_uris: [REDIRECT] }) {
    const res = await h.send(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: res.status, body: (await res.json()) as any }
  }

  function pkce() {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
  }

  function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    return new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-123',
      resource: `${ORIGIN}/mcp`,
      scope: 'workspaces:read workspaces:write messages:write projects:read',
      ...extra
    })
  }

  /** GET the consent page, then post the form the way a browser would. */
  async function consent(params: URLSearchParams, credential: string, opts: { decision?: string; untick?: string[]; csrf?: string | null } = {}) {
    const page = await h.send(new Request(`${ORIGIN}/oauth/authorize?${params}`))
    expect(page.status).toBe(200)
    const html = await page.text()
    const cookie = /__Host-orca_mcp_csrf=([A-Za-z0-9]+)/.exec(page.headers.get('set-cookie') ?? '')![1]
    const form = new URLSearchParams()
    for (const [, name = '', value = ''] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      form.set(name, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
    }
    for (const [, scope = ''] of html.matchAll(/name="grant" value="([^"]+)" checked/g)) {
      if (!opts.untick?.includes(scope)) form.append('grant', scope)
    }
    if (opts.csrf !== undefined) {
      opts.csrf === null ? form.delete('csrf') : form.set('csrf', opts.csrf)
    }
    form.set('credential', credential)
    form.set('decision', opts.decision ?? 'approve')
    const res = await h.send(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-orca_mcp_csrf=${cookie}`, origin: ORIGIN },
        body: form.toString()
      })
    )
    return { res, html, location: res.headers.get('location') ? new URL(res.headers.get('location')!) : null }
  }

  async function tokenRequest(fields: Record<string, string>) {
    const res = await h.send(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }))
    return { status: res.status, body: (await res.json()) as any }
  }

  /** DCR + PKCE + consent + code exchange. */
  async function connect(credential: string, extra: Record<string, string> = {}) {
    const client = (await register()).body
    const { verifier, challenge } = pkce()
    const { location } = await consent(authorizeParams(client.client_id, challenge, extra), credential)
    const code = location!.searchParams.get('code')!
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${ORIGIN}/mcp` })
    expect(tokens.status).toBe(200)
    return { client, code, verifier, tokens: tokens.body as { access_token: string; refresh_token: string; scope: string; expires_in: number } }
  }

  return { ...h, rpc, tool, apiKey, register, pkce, authorizeParams, consent, tokenRequest, connect, settle: () => Promise.all(pending.splice(0)) }
}

describe('MCP protocol', () => {
  it('initializes with version negotiation, statelessly, and lists annotated tools', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const init = await h.rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.status).toBe(200)
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orca-cloud' } })
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const future = await h.rpc(key, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(future.body.result.protocolVersion).toBe('2025-11-25')

    const note = await h.send(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }))
    expect(note.status).toBe(202)
    expect((await h.rpc(key, 'ping')).body.result).toEqual({})

    const list = await h.rpc(key, 'tools/list', {}, { 'mcp-protocol-version': '2025-11-25' })
    const tools = list.body.result.tools as { name: string; inputSchema: any; annotations: any; description: string }[]
    expect(tools.map((t) => t.name)).toEqual([
      'whoami', 'list_projects', 'list_workspaces', 'get_workspace', 'create_workspace', 'sleep_workspace', 'wake_workspace',
      'archive_workspace', 'destroy_workspace', 'send_message', 'get_message', 'list_sessions', 'read_session', 'list_routines', 'run_routine'
    ])
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(40)
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, (typeof tools)[number]>
    expect(byName.destroy_workspace!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(byName.list_workspaces!.annotations.readOnlyHint).toBe(true)
    expect(byName.sleep_workspace!.annotations.idempotentHint).toBe(true)
    expect(byName.send_message!.inputSchema.required).toEqual(['workspaceId', 'text'])
  })

  it('rejects bad transport input: method, origin, version header, JSON, unknown method/tool', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    expect((await h.send(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${key}` } }))).status).toBe(405)
    expect((await h.rpc(key, 'ping', undefined, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await h.rpc(key, 'ping', undefined, { origin: ORIGIN })).status).toBe(200)
    expect((await h.rpc(key, 'tools/list', {}, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
    const bad = await h.send(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{nope' }))
    expect(((await bad.json()) as any).error.code).toBe(-32700)
    expect((await h.rpc(key, 'resources/list')).body.error.code).toBe(-32601)
    expect((await h.rpc(key, 'tools/call', { name: 'rm_rf', arguments: {} })).body.error.code).toBe(-32602)
    // Bad arguments are tool errors the model can correct, and ids cannot escape their route.
    const invalid = await h.tool(key, 'get_workspace', { workspaceId: '../api-keys' })
    expect(invalid).toMatchObject({ isError: true, structuredContent: { error: 'invalid_arguments' } })
  })

  it('runs the workspace lifecycle through the public API with its scopes and audit trail', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read', 'workspaces:write', 'messages:write', 'projects:read'])
    expect((await h.tool(key, 'whoami')).structuredContent).toMatchObject({ accountId: 'user:alice', via: 'user' })
    const created = await h.tool(key, 'create_workspace', { name: 'mcp-ws', repoUrl: 'https://github.com/acme/app' })
    expect(created.isError).toBeUndefined()
    const ws = created.structuredContent.workspace
    expect(ws).toMatchObject({ name: 'mcp-ws', status: 'running', origin: 'api', repoUrl: 'https://github.com/acme/app' })
    expect(JSON.parse(created.content[0]!.text).workspace.id).toBe(ws.id)
    expect((await h.tool(key, 'list_workspaces')).structuredContent.workspaces).toHaveLength(1)
    expect((await h.tool(key, 'get_workspace', { workspaceId: ws.id })).structuredContent.workspace.id).toBe(ws.id)
    expect((await h.tool(key, 'sleep_workspace', { workspaceId: ws.id })).structuredContent.workspace.status).toBe('sleeping')
    expect((await h.tool(key, 'wake_workspace', { workspaceId: ws.id })).structuredContent.workspace.status).toBe('running')

    h.vercel.commandHandler = (params) => {
      const args = params.args ?? []
      if (args.includes('agent')) return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term_abc' } } }), stderr: '' }
      if (args.includes('read')) return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term_abc', status: 'idle', tail: ['> hello', 'pong   ', '', ''] } } }), stderr: '' }
      if (args.includes('terminal')) return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_abc', title: 'claude', connected: true, preview: 'done' }] } }), stderr: '' }
      return undefined
    }
    const sent = await h.tool(key, 'send_message', { workspaceId: ws.id, text: 'hello', waitSeconds: 0 })
    expect(sent.structuredContent.message.status).toBe('queued')
    await h.settle()
    const message = await h.tool(key, 'get_message', { workspaceId: ws.id, messageId: sent.structuredContent.message.id })
    expect(message.structuredContent.message).toMatchObject({ status: 'delivered', session: 'term_abc' })
    const sessions = await h.tool(key, 'list_sessions', { workspaceId: ws.id })
    expect(sessions.structuredContent.sessions[0]).toMatchObject({ handle: 'term_abc', connected: true })
    const screen = await h.tool(key, 'read_session', { workspaceId: ws.id, session: 'term_abc' })
    expect(screen.structuredContent.session).toMatchObject({ handle: 'term_abc', status: 'idle', screen: '> hello\npong' })

    expect((await h.tool(key, 'archive_workspace', { workspaceId: ws.id })).structuredContent.workspace.archived).toBe(true)
    expect((await h.tool(key, 'destroy_workspace', { workspaceId: ws.id })).structuredContent.workspace.status).toBe('destroyed')
    const missing = await h.tool(key, 'get_workspace', { workspaceId: ws.id })
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: 'not_found', status: 404 } })

    const audit = h.raw.prepare('SELECT action, actor_type FROM audit_log ORDER BY created_at, rowid').all() as { action: string; actor_type: string }[]
    expect(audit.filter((a) => a.action.startsWith('workspace.')).map((a) => [a.action, a.actor_type])).toEqual([
      ['workspace.create', 'api_key'], ['workspace.sleep', 'api_key'], ['workspace.wake', 'api_key'], ['workspace.message', 'api_key'],
      ['workspace.archive', 'api_key'], ['workspace.destroy', 'api_key']
    ])
  })

  it('reports missing scopes and rate limits as tool errors', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const denied = await h.tool(key, 'create_workspace', {})
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: 'insufficient_scope', reason: 'workspaces:write' } })
    expect(denied.structuredContent.hint).toMatch(/scope/)
    expect((await h.tool(key, 'list_projects')).structuredContent.reason).toBe('projects:read')
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandboxes').get()).toEqual({ n: 0 })
    for (let i = 0; i < 118; i++) await h.tool(key, 'list_workspaces')
    const limited = await h.tool(key, 'list_workspaces')
    expect(limited).toMatchObject({ isError: true, structuredContent: { error: 'rate_limited' } })
    expect(limited.structuredContent.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe('MCP authorization', () => {
  it('answers unauthenticated requests with RFC 9728 discovery and serves AS metadata', async () => {
    const h = await harness()
    const res = await h.rpc(null, 'initialize', { protocolVersion: '2025-11-25' })
    expect(res.status).toBe(401)
    const challenge = res.headers.get('www-authenticate')!
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    expect((await h.rpc('orca_sk_00000000000000000000000000000000', 'ping')).headers.get('www-authenticate')).toContain('error="invalid_token"')

    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = (await (await h.send(new Request(`${ORIGIN}${path}`))).json()) as any
      expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] })
    }
    const as = (await (await h.send(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()) as any
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    })
  })

  it('validates dynamic client registrations', async () => {
    const h = await harness()
    const ok = await h.register({ client_name: 'Claude Code', redirect_uris: [REDIRECT, 'https://claude.ai/api/mcp/auth_callback', 'cursor://anysphere.cursor-mcp/oauth/callback'], token_endpoint_auth_method: 'client_secret_basic' })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ client_name: 'Claude Code', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
    expect(ok.body.client_id).toMatch(/^mcpc_/)
    for (const uris of [[], ['http://evil.example/cb'], ['javascript:alert(1)'], ['https://a.example/cb#frag'], 'https://x']) {
      expect((await h.register({ redirect_uris: uris })).body.error).toBe('invalid_redirect_uri')
    }
    expect((await h.register({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] })).status).toBe(400)
    // The client name cannot smuggle markup or bidi tricks into the consent page.
    const sneaky = (await h.register({ client_name: '<b>Orca</b>‮eviL', redirect_uris: [REDIRECT] })).body
    const page = await (await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams(sneaky.client_id, h.pkce().challenge)}`))).text()
    expect(page).toContain('&lt;b&gt;Orca&lt;/b&gt;eviL')
  })

  it('completes DCR + PKCE + consent and the token works only on /mcp, as the approving user', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read', 'workspaces:write', 'messages:write', 'projects:read', 'routines:read'])
    const client = (await h.register()).body
    const { verifier, challenge } = h.pkce()
    const { res, html, location } = await h.consent(h.authorizeParams(client.client_id, challenge), key)
    expect(html).toContain('Test Client')
    expect(html).toContain('127.0.0.1:33418')
    expect(res.status).toBe(302)
    expect(location!.origin + location!.pathname).toBe(REDIRECT)
    expect(location!.searchParams.get('state')).toBe('st-123')
    expect(location!.searchParams.get('iss')).toBe(ORIGIN)
    const code = location!.searchParams.get('code')!

    const tokens = await h.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${ORIGIN}/mcp` })
    expect(tokens.status).toBe(200)
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'workspaces:read workspaces:write messages:write projects:read' })
    const access = tokens.body.access_token as string
    expect(access).toMatch(/^orca_oat_/)
    expect(tokens.body.refresh_token).toMatch(/^orca_ort_/)
    expect(JSON.stringify(h.raw.prepare('SELECT * FROM api_keys').all())).not.toContain(access.slice(9))

    const me = await h.tool(access, 'whoami')
    expect(me.structuredContent).toMatchObject({ accountId: 'user:alice', userId: 'alice', via: 'oauth' })
    const ws = (await h.tool(access, 'create_workspace', { name: 'from-mcp' })).structuredContent.workspace
    expect(ws.origin).toBe('mcp')
    const actor = h.raw.prepare(`SELECT actor_type FROM audit_log WHERE action = 'workspace.create'`).get()
    expect(actor).toEqual({ actor_type: 'mcp' })
    expect(h.raw.prepare(`SELECT action FROM audit_log WHERE action = 'mcp.authorize'`).all()).toHaveLength(1)
    // Audience-bound: not a REST credential, and refresh tokens are never bearer credentials.
    expect((await h.call('GET', '/v1/me', { bearer: access })).status).toBe(401)
    expect((await h.rpc(tokens.body.refresh_token, 'ping')).status).toBe(401)
    // Expires after an hour.
    h.advance(3_600_001)
    expect((await h.rpc(access, 'ping')).status).toBe(401)
  })

  it('rejects PKCE failures, replayed codes (revoking what they minted) and expired codes', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const client = (await h.register()).body
    const { verifier, challenge } = h.pkce()
    const { location } = await h.consent(h.authorizeParams(client.client_id, challenge, { scope: 'workspaces:read' }), key)
    const code = location!.searchParams.get('code')!
    const base = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT }
    expect((await h.tokenRequest({ ...base, code_verifier: h.pkce().verifier })).body).toMatchObject({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
    expect((await h.tokenRequest({ ...base, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:1/x' })).body.error).toBe('invalid_grant')
    expect((await h.tokenRequest({ ...base, code_verifier: verifier, resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target')
    const other = (await h.register()).body
    expect((await h.tokenRequest({ ...base, client_id: other.client_id, code_verifier: verifier })).body.error).toBe('invalid_grant')
    const first = await h.tokenRequest({ ...base, code_verifier: verifier })
    expect(first.status).toBe(200)
    expect((await h.rpc(first.body.access_token, 'ping')).status).toBe(200)
    const replay = await h.tokenRequest({ ...base, code_verifier: verifier })
    expect(replay.body).toMatchObject({ error: 'invalid_grant', error_description: 'Authorization code already used' })
    expect((await h.rpc(first.body.access_token, 'ping')).status).toBe(401)
    expect((await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant')

    const late = h.pkce()
    const second = await h.consent(h.authorizeParams(client.client_id, late.challenge, { scope: 'workspaces:read' }), key)
    h.advance(5 * 60_000 + 1)
    expect((await h.tokenRequest({ ...base, code: second.location!.searchParams.get('code')!, code_verifier: late.verifier })).body.error_description).toBe('Authorization code expired')
  })

  it('rotates refresh tokens and kills the grant when a rotated token is replayed', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read', 'workspaces:write'])
    const { client, tokens } = await h.connect(key, { scope: 'workspaces:read workspaces:write' })
    const refresh = (token: string, extra: Record<string, string> = {}) => h.tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id, ...extra })
    const next = await refresh(tokens.refresh_token)
    expect(next.status).toBe(200)
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token)
    expect((await h.tool(next.body.access_token, 'whoami')).structuredContent.scopes).toEqual(['workspaces:read', 'workspaces:write'])
    // Narrowing is allowed, widening is not.
    const narrowed = await refresh(next.body.refresh_token, { scope: 'workspaces:read' })
    expect(narrowed.body.scope).toBe('workspaces:read')
    expect((await refresh(narrowed.body.refresh_token, { scope: 'audit:read' })).body.error).toBe('invalid_scope')
    // That failed attempt still consumed nothing it shouldn't have; replaying an old token ends everything.
    const replay = await refresh(tokens.refresh_token)
    expect(replay.body.error).toBe('invalid_grant')
    expect((await h.rpc(next.body.access_token, 'ping')).status).toBe(401)
    expect((await h.rpc(narrowed.body.access_token, 'ping')).status).toBe(401)
    expect(h.raw.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mcp.refresh_replay'`).get()).toEqual({ n: 1 })
    // Another client cannot use this client's refresh token.
    const fresh = await h.connect(key, { scope: 'workspaces:read' })
    const stranger = (await h.register()).body
    expect((await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: fresh.tokens.refresh_token, client_id: stranger.client_id })).body.error).toBe('invalid_grant')
  })

  it('stops working when revoked, by RFC 7009 or in the database, and API key fallback stops with its key', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const { client, tokens } = await h.connect(key, { scope: 'workspaces:read' })
    expect((await h.rpc(tokens.access_token, 'ping')).status).toBe(200)
    const res = await h.send(new Request(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: client.client_id }).toString() }))
    expect(res.status).toBe(200)
    expect((await h.rpc(tokens.access_token, 'ping')).status).toBe(401)

    // Revoking the user API key used directly as an MCP credential.
    expect((await h.rpc(key, 'ping')).status).toBe(200)
    const id = (h.raw.prepare(`SELECT id FROM api_keys WHERE kind = 'user'`).get() as { id: string }).id
    expect((await h.call('DELETE', `/v1/api-keys/${id}`)).status).toBe(200)
    expect((await h.rpc(key, 'ping')).status).toBe(401)
  })

  it('binds tokens to the MCP resource (RFC 8707)', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const client = (await h.register()).body
    const res = await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams(client.client_id, h.pkce().challenge, { resource: 'https://other.example/mcp' })}`))
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_target')
    const { tokens } = await h.connect(key, { scope: 'workspaces:read' })
    h.raw.prepare(`UPDATE api_keys SET audience = 'https://other.example/mcp' WHERE kind = 'oauth'`).run()
    expect((await h.rpc(tokens.access_token, 'ping')).status).toBe(401)
  })

  it('never redirects to an unregistered URI and enforces CSRF, PKCE method and consent choices', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read', 'workspaces:write'])
    const client = (await h.register()).body
    const { challenge } = h.pkce()
    const evil = await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams(client.client_id, challenge, { redirect_uri: 'http://127.0.0.1:33419/callback' })}`))
    expect(evil.status).toBe(400)
    expect(evil.headers.get('location')).toBeNull()
    expect((await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams('mcpc_00000000000000000000', challenge)}`))).status).toBe(400)
    const plain = await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams(client.client_id, challenge, { code_challenge_method: 'plain' })}`))
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')

    const page = await h.send(new Request(`${ORIGIN}/oauth/authorize?${h.authorizeParams(client.client_id, challenge)}`))
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('content-security-policy')).toContain('form-action \'self\' http://127.0.0.1:33418')
    expect(page.headers.get('set-cookie')).toMatch(/__Host-orca_mcp_csrf=\w+; Path=\/; Secure; HttpOnly; SameSite=Strict/)

    expect((await h.consent(h.authorizeParams(client.client_id, challenge), key, { csrf: null })).res.status).toBe(403)
    expect((await h.consent(h.authorizeParams(client.client_id, challenge), key, { csrf: 'A'.repeat(32) })).res.status).toBe(403)
    const denied = await h.consent(h.authorizeParams(client.client_id, challenge), key, { decision: 'deny' })
    expect(denied.location!.searchParams.get('error')).toBe('access_denied')
    const wrong = await h.consent(h.authorizeParams(client.client_id, challenge), 'orca_sk_00000000000000000000000000000000')
    expect(wrong.res.status).toBe(401)
    expect(await wrong.res.text()).toContain('not valid')

    // Unticked scopes and scopes the approving key lacks are not granted.
    const { tokens } = await h.connect(key)
    expect(tokens.scope).toBe('workspaces:read workspaces:write')
    const partial = h.pkce()
    const unticked = await h.consent(h.authorizeParams(client.client_id, partial.challenge), key, { untick: ['workspaces:write'] })
    const narrow = await h.tokenRequest({ grant_type: 'authorization_code', code: unticked.location!.searchParams.get('code')!, code_verifier: partial.verifier, client_id: client.client_id })
    expect(narrow.body.scope).toBe('workspaces:read')
    expect((await h.tool(narrow.body.access_token, 'create_workspace', {})).structuredContent.error).toBe('insufficient_scope')
  })

  it('approves with a one-time desktop approval code bounded by the member role', async () => {
    const h = await harness()
    const member = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member' })
    expect((await h.call('POST', '/v1/oauth-approvals', { bearer: member, body: { scopes: ['audit:read'] } })).status).toBe(403)
    const approval = await h.call('POST', '/v1/oauth-approvals', { bearer: member, body: {} })
    expect(approval.status).toBe(201)
    expect(approval.body.code).toMatch(/^orca_ap_/)
    expect(approval.body.scopes).not.toContain('audit:read')
    // Keys cannot mint approvals.
    const key = await h.apiKey(['workspaces:read'])
    expect((await h.call('POST', '/v1/oauth-approvals', { bearer: key, body: {} })).status).toBe(403)

    const { tokens } = await h.connect(approval.body.code, { scope: 'workspaces:read audit:read projects:read' })
    expect(tokens.scope).toBe('workspaces:read projects:read')
    expect((await h.tool(tokens.access_token, 'whoami')).structuredContent).toMatchObject({ accountId: 'org:acme', userId: 'bob', role: 'member' })
    // Single use.
    const client = (await h.register()).body
    const again = await h.consent(h.authorizeParams(client.client_id, h.pkce().challenge), approval.body.code)
    expect(again.res.status).toBe(401)
  })
})

describe('MCP grants', () => {
  it('lists connected apps, lets owners and admins disconnect them, and audits it', async () => {
    const h = await harness()
    const memberJwt = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member' })
    const adminJwt = await h.token('carol', 'acme', 'sandbox', { orgRole: 'admin' })
    const bobKey = await h.apiKey(['workspaces:read'], 'bob', { org: 'acme', role: 'member' })
    const carolKey = await h.apiKey(['workspaces:read'], 'carol', { org: 'acme', role: 'admin' })
    const bob = await h.connect(bobKey, { scope: 'workspaces:read' })
    const carol = await h.connect(carolKey, { scope: 'workspaces:read' })
    await h.rpc(bob.tokens.access_token, 'ping')

    const mine = await h.call('GET', '/v1/oauth-grants', { bearer: memberJwt })
    expect(mine.status).toBe(200)
    expect(mine.body.grants).toHaveLength(1)
    const grant = mine.body.grants[0]
    expect(grant).toMatchObject({ clientName: 'Test Client', userId: 'bob', scopes: ['workspaces:read'], approvedWith: { apiKeyPrefix: bobKey.slice(0, 12) } })
    expect(grant.id).toMatch(/^fam_/)
    expect(grant.expiresAt).toBe(grant.grantedAt + 90 * 86_400_000)
    expect((await h.call('GET', '/v1/oauth-grants', { bearer: adminJwt })).body.grants).toHaveLength(2)
    // Keys cannot manage grants; other accounts cannot see them.
    expect((await h.call('GET', '/v1/oauth-grants', { bearer: bobKey })).status).toBe(403)
    expect((await h.call('GET', '/v1/oauth-grants', { as: 'mallory' })).body.grants).toHaveLength(0)

    // A member cannot disconnect the admin's app; the admin can disconnect the member's.
    const carolGrant = (await h.call('GET', '/v1/oauth-grants', { bearer: adminJwt })).body.grants.find((g: { userId: string }) => g.userId === 'carol')
    expect((await h.call('DELETE', `/v1/oauth-grants/${carolGrant.id}`, { bearer: memberJwt })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/oauth-grants/${grant.id}`, { as: 'mallory' })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/oauth-grants/${grant.id}`, { bearer: adminJwt })).status).toBe(200)
    expect((await h.rpc(bob.tokens.access_token, 'ping')).status).toBe(401)
    expect((await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: bob.tokens.refresh_token, client_id: bob.client.client_id })).body.error).toBe('invalid_grant')
    expect((await h.rpc(carol.tokens.access_token, 'ping')).status).toBe(200)
    expect((await h.call('GET', '/v1/oauth-grants', { bearer: memberJwt })).body.grants).toHaveLength(0)
    expect(h.raw.prepare(`SELECT actor_type, target_id FROM audit_log WHERE action = 'mcp.grant_revoke'`).all()).toEqual([{ actor_type: 'user', target_id: grant.id }])
  })

  it('revokes every grant an API key approved when that key is revoked, pending codes included', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const { client, tokens } = await h.connect(key, { scope: 'workspaces:read' })
    const next = await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })
    expect(next.status).toBe(200)
    // A code approved with the key but not exchanged yet.
    const pending = h.pkce()
    const consent = await h.consent(h.authorizeParams(client.client_id, pending.challenge, { scope: 'workspaces:read' }), key)
    const id = (h.raw.prepare(`SELECT id FROM api_keys WHERE kind = 'user'`).get() as { id: string }).id
    expect((await h.call('DELETE', `/v1/api-keys/${id}`)).status).toBe(200)
    expect((await h.rpc(next.body.access_token, 'ping')).status).toBe(401)
    expect((await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: next.body.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant')
    const late = await h.tokenRequest({ grant_type: 'authorization_code', code: consent.location!.searchParams.get('code')!, code_verifier: pending.verifier, client_id: client.client_id })
    expect(late.body).toMatchObject({ error: 'invalid_grant', error_description: 'The credential that approved this grant was revoked' })
    expect(h.raw.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE kind IN ('oauth', 'oauth_refresh') AND revoked_at IS NULL`).get()).toEqual({ n: 0 })
  })

  it('ends a grant 90 days after approval however often it is refreshed', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const { client, tokens } = await h.connect(key, { scope: 'workspaces:read' })
    let refresh = tokens.refresh_token
    for (let i = 0; i < 3; i++) {
      h.advance(29 * 86_400_000)
      const next = await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id })
      expect(next.status).toBe(200)
      refresh = next.body.refresh_token
    }
    // The last pair cannot outlive the grant.
    const last = h.raw.prepare(`SELECT expires_at, family_expires_at FROM api_keys WHERE kind = 'oauth_refresh' AND revoked_at IS NULL`).get() as { expires_at: number; family_expires_at: number }
    expect(last.expires_at).toBe(last.family_expires_at)
    h.advance(3 * 86_400_000 + 1)
    expect((await h.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id })).body.error).toBe('invalid_grant')
  })

  it('kills tokens minted while the code was being replayed (claim/mint race)', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const client = (await h.register()).body
    const { verifier, challenge } = h.pkce()
    const { location } = await h.consent(h.authorizeParams(client.client_id, challenge, { scope: 'workspaces:read' }), key)
    // Simulate a replay landing between the claim and the mint: the first token insert flags it.
    h.raw.exec(`CREATE TRIGGER replay_mid_flight AFTER INSERT ON api_keys WHEN NEW.kind = 'oauth' BEGIN UPDATE oauth_codes SET replayed_at = 1; END`)
    const res = await h.tokenRequest({ grant_type: 'authorization_code', code: location!.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id })
    expect(res.body).toMatchObject({ error: 'invalid_grant', error_description: 'Grant revoked' })
    expect(h.raw.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE kind IN ('oauth', 'oauth_refresh') AND revoked_at IS NULL`).get()).toEqual({ n: 0 })
  })

  it("consumes a removed member's pending codes and approval codes", async () => {
    const OP = 'o'.repeat(40)
    const h = await harness({ OPERATOR_TOKEN: OP })
    const bobJwt = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member' })
    const approval = (await h.call('POST', '/v1/oauth-approvals', { bearer: bobJwt, body: {} })).body.code
    const unused = (await h.call('POST', '/v1/oauth-approvals', { bearer: bobJwt, body: {} })).body.code
    const client = (await h.register()).body
    const { verifier, challenge } = h.pkce()
    const { location } = await h.consent(h.authorizeParams(client.client_id, challenge, { scope: 'workspaces:read' }), approval)
    const removed = await h.call('POST', '/v1/internal/members/removed', { bearer: OP, body: { accountId: 'org:acme', userId: 'bob' } })
    expect(removed.status).toBe(200)
    expect((await h.tokenRequest({ grant_type: 'authorization_code', code: location!.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id })).body.error).toBe('invalid_grant')
    expect((await h.consent(h.authorizeParams(client.client_id, h.pkce().challenge), unused)).res.status).toBe(401)
  })

  it('purges abandoned registrations and dead codes, and limits the token endpoint per IP', async () => {
    const h = await harness()
    const key = await h.apiKey(['workspaces:read'])
    const used = await h.connect(key, { scope: 'workspaces:read' })
    const abandoned = (await h.register()).body
    h.advance(25 * 3_600_000)
    expect(await purgeOAuth(h.env.SANDBOX_DB, h.now())).toBeGreaterThanOrEqual(1)
    const left = (h.raw.prepare('SELECT client_id FROM oauth_clients').all() as { client_id: string }[]).map((r) => r.client_id)
    expect(left).toContain(used.client.client_id)
    expect(left).not.toContain(abandoned.client_id)
    h.advance(24 * 3_600_000)
    await purgeOAuth(h.env.SANDBOX_DB, h.now())
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 })

    const hit = () =>
      h.send(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.9' }, body: 'grant_type=refresh_token&client_id=mcpc_00000000000000000000' }))
    for (let i = 0; i < 120; i++) expect((await hit()).status).toBe(401)
    expect((await hit()).status).toBe(429)
  })
})
