// Share links end to end in-process: desktop routes, the public gateway, and the real in-VM share
// proxy (image/vm/orca-share-proxy, spawned with node) in front of a local "dev server".
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { shareProxyKey, signProxyHeader } from '../src/share-crypto'
import { LINK_CACHE_MS } from '../src/share-gateway'
import { MAX_SHARE_WAKES_PER_DAY } from '../src/share-links'

const WAKE_GAP_MS = 61_000
import { createHarness } from './harness'

const SECRET = 's'.repeat(40)
const PROXY = fileURLToPath(new URL('../image/vm/orca-share-proxy', import.meta.url).href)

let app: http.Server
let appPort = 0
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = []
const proxies: ChildProcess[] = []

beforeAll(async () => {
  app = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/landing' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['app=1; Path=/', 'wide=1; Domain=share.test; Path=/; Secure', '__orca_share=evil; Path=/'] })
    res.end(`hello ${req.url}`)
  })
  app.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  appPort = (app.address() as net.AddressInfo).port
})

afterAll(() => {
  app.close()
  for (const child of proxies) {
    child.kill()
  }
})

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  server.close()
  return port
}

/** Starts the real share proxy for a session key; returns its local port. */
async function startProxy(key: string): Promise<number> {
  const port = await freePort()
  // The key goes in on stdin, as orca-sandbox-start pipes it; never through the environment.
  const child = spawn(process.execPath, [PROXY], { env: { ORCA_SHARE_PROXY_PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'] })
  child.stdin!.end(key)
  proxies.push(child)
  await once(child.stdout!, 'data')
  return port
}

async function setup(options: { audience?: 'public' | 'team'; allowWake?: boolean; port?: number } = {}) {
  let proxyPort = 0
  const routed: string[] = []
  const background: Promise<unknown>[] = []
  const h = await createHarness(
    { SHARE_LINK_SECRET: SECRET },
    {
      waitUntil: (work) => void background.push(work),
      // The fake route `https://sb-N-6769.vercel.run` is the local proxy.
      shareFetch: (async (input: string, init?: RequestInit) => {
        routed.push(String(input))
        return fetch(String(input).replace(/^https:\/\/sb-\d+-6769\.vercel\.run/, `http://127.0.0.1:${proxyPort}`), init)
      }) as typeof fetch
    }
  )
  const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const sandbox = created.body.sandbox
  const key = await shareProxyKey(SECRET, sandbox.id, sandbox.session.id)
  proxyPort = await startProxy(key)
  const share = await h.call('POST', `/v1/sandboxes/${sandbox.id}/shares`, {
    body: { port: options.port ?? appPort, audience: options.audience ?? 'public', expiresIn: '1h', allowWake: options.allowWake ?? false }
  })
  expect(share.status).toBe(200)
  const visit = (path: string, init: RequestInit = {}) => h.send(new Request(new URL(path, 'https://sandbox.test'), init))
  const settle = () => Promise.all(background.splice(0))
  return { h, sandbox, key, share: share.body.share, routed, visit, settle, setProxyKey: async (next: string) => (proxyPort = await startProxy(next)) }
}

describe('share links', () => {
  it('passes each session its share-proxy key and declares the proxy port', async () => {
    const { h, sandbox, key } = await setup()
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)
    expect(start!.env.ORCA_SHARE_PROXY_KEY).toBe(key)
    expect([...h.vercel.boxes.values()][0]!.params.ports).toEqual([6768, 6769])
    expect(sandbox.id).toMatch(/^sbx_/)
  })

  it('creates, lists and revokes links; validates input; hides other accounts', async () => {
    const { h, sandbox, share } = await setup()
    expect(share).toMatchObject({ audience: 'public', allowWake: false, state: 'active', port: appPort, revokedAt: null })
    expect(share.url).toMatch(/^https:\/\/sandbox\.test\/s\/[0-9a-f]{52}\/$/)
    expect(share.expiresAt - share.createdAt).toBe(3_600_000)
    for (const body of [{ port: 6768, audience: 'public', expiresIn: '1h' }, { port: 3000, audience: 'world', expiresIn: '1h' }, { port: 3000, audience: 'public', expiresIn: '2y' }]) {
      expect((await h.call('POST', `/v1/sandboxes/${sandbox.id}/shares`, { body })).status).toBe(400)
    }
    expect((await h.call('GET', `/v1/sandboxes/${sandbox.id}/shares`, { as: 'bob' })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/sandboxes/${sandbox.id}/shares/${share.id}`, { as: 'bob' })).status).toBe(404)
    const listed = await h.call('GET', `/v1/sandboxes/${sandbox.id}/shares`)
    expect(listed.body.shares.map((s: { id: string }) => s.id)).toEqual([share.id])
    const revoked = await h.call('DELETE', `/v1/sandboxes/${sandbox.id}/shares/${share.id}`)
    expect(revoked.body.share.state).toBe('revoked')
  })

  it('proxies a link with its own cookies only, no referrer and no visitor identity', async () => {
    const { share, visit } = await setup()
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.url)![1]!
    const mine = `s${share.id.slice(0, 8)}.mine`
    const res = await visit(`${share.url}api/x?q=1`, {
      headers: {
        cookie: `${mine}=1; other=2; s00000000.theirs=3; __orca_viewer=secret; __Host-orca_mcp_csrf=4`,
        referer: `https://sandbox.test/s/${token}/`
      }
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello /api/x?q=1')
    const request = seen.at(-1)!
    expect(request.headers.host).toBe(`localhost:${appPort}`)
    expect(request.headers.cookie).toBe('mine=1')
    expect(request.headers.referer).toBeUndefined()
    expect(request.headers['x-orca-share']).toBeUndefined()
    expect(request.headers['x-forwarded-prefix']).toBe(`/s/${token}`)
    expect(res.headers.get('x-orca-share-proxy')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    // App cookies come back renamed and scoped to this link; the app can't set gateway cookies.
    const prefix = mine.replace('mine', '')
    expect(res.headers.getSetCookie()).toEqual([`${prefix}app=1; Path=/s/${token}/`, `${prefix}wide=1; Secure; Path=/s/${token}/`])
  })

  it('keeps shared-origin hazards out of path mode', async () => {
    const { share, visit } = await setup()
    // Root-relative paths are control-plane routes, never a link's app.
    expect((await visit('/assets/app.js', { headers: { cookie: '__orca_share=x' } })).status).toBe(404)
    const worker = await visit(`${share.url}sw.js`, { headers: { 'service-worker': 'script' } })
    expect(worker.status).toBe(403)
  })

  it('keeps app redirects under the link', async () => {
    const { share, visit } = await setup()
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.url)![1]!
    const redirect = await visit(`${share.url}redirect`)
    expect(redirect.headers.get('location')).toBe(`/s/${token}/landing`)
    expect((await visit(share.url.slice(0, -1))).headers.get('location')).toBe(`/s/${token}/`)
  })

  it('refuses forged, revoked and expired links', async () => {
    const { h, sandbox, share, visit } = await setup()
    const forged = share.url.replace(/([0-9a-f])\/$/, (_: string, c: string) => `${c === '0' ? '1' : '0'}/`)
    expect((await visit(forged)).status).toBe(404)
    await h.call('DELETE', `/v1/sandboxes/${sandbox.id}/shares/${share.id}`)
    const revoked = await visit(share.url)
    expect(revoked.status).toBe(410)
    expect(await revoked.text()).toContain('turned off')
    const second = (await h.call('POST', `/v1/sandboxes/${sandbox.id}/shares`, { body: { port: appPort, audience: 'public', expiresIn: '1h' } })).body.share
    expect((await visit(second.url)).status).toBe(200)
    h.advance(3_600_000 + LINK_CACHE_MS)
    const expired = await visit(second.url)
    expect(expired.status).toBe(410)
    expect(await expired.text()).toContain('expired')
  })

  it('makes the raw proxy route useless without a gateway signature', async () => {
    const { key } = await setup()
    const port = await startProxy(key)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
    const grant = (port: number, linkExpiresAt = Date.now() + 3_600_000) => ({ port, linkId: 'a'.repeat(32), linkExpiresAt })
    const status = async (header: string) => (await fetch(`http://127.0.0.1:${port}/ok`, { headers: { 'x-orca-share': header } })).status
    expect(await status(await signProxyHeader(await shareProxyKey('x'.repeat(40), 'sbx', 'sess'), grant(appPort), Date.now()))).toBe(404)
    expect(await status(await signProxyHeader(key, grant(6768), Date.now()))).toBe(404)
    expect(await status(await signProxyHeader(key, grant(2222), Date.now()))).toBe(404)
    expect(await status(await signProxyHeader(key, grant(appPort), Date.now() - 120_000))).toBe(404)
    // Link already expired: nothing to serve.
    expect(await status(await signProxyHeader(key, grant(appPort, Date.now() - 1000), Date.now()))).toBe(404)
    const good = await signProxyHeader(key, grant(appPort), Date.now())
    expect(await status(good)).toBe(200)
    expect(await status(good.replace(/\.[0-9a-f]{32}\./, `.${'b'.repeat(32)}.`))).toBe(404)
  })

  it('pipes WebSocket upgrades through the proxy and closes them when the link ends', async () => {
    const { key } = await setup()
    const port = await startProxy(key)
    const header = await signProxyHeader(key, { port: appPort, linkId: 'a'.repeat(32), linkExpiresAt: Date.now() + 2500 }, Date.now())
    const socket = net.connect(port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(`GET /ws HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\nx-orca-share: ${header}\r\n\r\n`)
    const [handshake] = await once(socket, 'data')
    expect(String(handshake)).toMatch(/^HTTP\/1\.1 101/)
    socket.write('ping')
    const [echo] = await once(socket, 'data')
    expect(String(echo)).toBe('ping')
    // The grant runs out with the link (rounded down to the second): the proxy hangs up.
    await once(socket, 'close')
  })

  it('shows a branded page when nothing listens on the port', async () => {
    const closed = await freePort()
    const { visit, share } = await setup({ port: closed })
    const res = await visit(share.url)
    expect(res.status).toBe(502)
    expect(await res.text()).toContain(`Nothing is running on port ${closed}`)
    expect(await (await visit(`${share.url}__orca/status?probe=1`)).json()).toMatchObject({ state: 'ready', listening: false })
    const listening = await setup()
    expect(await (await listening.visit(`${listening.share.url}__orca/status?probe=1`)).json()).toMatchObject({ listening: true })
  })

  it('admits only signed-in members of the owning team to team-only links', async () => {
    const { h, share, visit } = await setup({ audience: 'team' })
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.url)![1]!
    const anonymous = await visit(share.url)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toContain(`orca://cloud-share/${token}`)
    expect((await h.call('POST', `/v1/shares/${token}/visit`, { as: 'bob' })).status).toBe(403)
    const entry = await h.call('POST', `/v1/shares/${token}/visit`)
    expect(entry.body.url).toContain('/__orca/enter?code=')
    const enter = await visit(entry.body.url)
    expect(enter.status).toBe(302)
    const viewer = enter.headers.getSetCookie().find((c) => c.startsWith('__orca_viewer='))!.split(';')[0]!
    expect(enter.headers.getSetCookie()[0]).toContain(`Path=/s/${token}/`)
    expect((await visit(share.url, { headers: { cookie: viewer } })).status).toBe(200)
    // A viewer session opens its own link only.
    const other = await h.call('POST', `/v1/sandboxes/${share.sandboxId}/shares`, { body: { port: appPort, audience: 'team', expiresIn: '1h' } })
    expect((await visit(other.body.share.url, { headers: { cookie: viewer } })).status).toBe(401)
    // The code works once, is bound to its link, and expires within a minute.
    expect((await visit(entry.body.url)).status).toBe(401)
    const late = await h.call('POST', `/v1/shares/${token}/visit`)
    h.advance(61_000)
    expect((await visit(late.body.url)).status).toBe(401)
  })

  it('lets only the workspace owner share it; an org admin may turn links off', async () => {
    const h = await createHarness({ SHARE_LINK_SECRET: SECRET })
    const as = (sub: string, orgRole?: string) => h.token(sub, 'acme', 'sandbox', orgRole ? { orgRole } : {})
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-own', machineSize: 'standard' }, bearer: await as('alice') })
    const path = `/v1/sandboxes/${created.body.sandbox.id}/shares`
    const body = { port: 3000, audience: 'public', expiresIn: '1h' }
    expect((await h.call('POST', path, { body, bearer: await as('bob') })).status).toBe(404)
    const share = await h.call('POST', path, { body, bearer: await as('alice') })
    expect((await h.call('GET', path, { bearer: await as('bob') })).status).toBe(404)
    expect((await h.call('DELETE', `${path}/${share.body.share.id}`, { bearer: await as('bob') })).status).toBe(404)
    expect((await h.call('GET', path, { bearer: await as('carol', 'admin') })).body.shares).toHaveLength(1)
    const revoked = await h.call('DELETE', `${path}/${share.body.share.id}`, { bearer: await as('carol', 'admin') })
    expect(revoked.body.share.state).toBe('revoked')
  })

  it('serves no path-mode links in prod, and keeps old links working across a secret rotation', async () => {
    const prod = await createHarness({ SHARE_LINK_SECRET: SECRET, SANDBOX_ENV: 'prod' })
    const created = await prod.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-p', machineSize: 'standard' } })
    expect((await prod.call('POST', `/v1/sandboxes/${created.body.sandbox.id}/shares`, { body: { port: 3000, audience: 'public', expiresIn: '1h' } })).status).toBe(503)

    const { h, share, visit } = await setup()
    h.env.SHARE_LINK_SECRET = 'n'.repeat(40)
    h.env.SHARE_LINK_SECRET_PREVIOUS = SECRET
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.url)![1]!
    expect((await h.call('POST', `/v1/shares/${token}/visit`)).status).toBe(200)
    // The running VM still holds a proxy key from the old secret: the gateway retries with it.
    expect((await visit(share.url)).status).toBe(200)
    h.env.SHARE_LINK_SECRET_PREVIOUS = undefined
    expect((await h.call('POST', `/v1/shares/${token}/visit`)).status).toBe(404)
  })

  it('serves subdomain-mode links at the root with host-only app cookies', async () => {
    const { h, share, visit } = await setup()
    h.env.SHARE_HOST_SUFFIX = '.share.test'
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.url)![1]!
    const res = await visit(`https://${token}.share.test/page`, { headers: { cookie: 'app=1' } })
    expect(await res.text()).toBe('hello /page')
    expect(seen.at(-1)!.headers.cookie).toBe('app=1')
    expect(res.headers.getSetCookie()).toEqual(['app=1; Path=/', 'wide=1; Path=/; Secure'])
  })

  it('admits members of the owning org and no one outside it', async () => {
    const h = await createHarness({ SHARE_LINK_SECRET: SECRET })
    const asMember = async (sub: string, org: string) => h.token(sub, org)
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-org', machineSize: 'standard' }, bearer: await asMember('alice', 'acme') })
    const share = await h.call('POST', `/v1/sandboxes/${created.body.sandbox.id}/shares`, {
      body: { port: appPort, audience: 'team', expiresIn: '24h' },
      bearer: await asMember('alice', 'acme')
    })
    const token = /\/s\/([0-9a-f]{52})\//.exec(share.body.share.url)![1]!
    expect((await h.call('POST', `/v1/shares/${token}/visit`, { bearer: await asMember('bob', 'acme') })).status).toBe(200)
    expect((await h.call('POST', `/v1/shares/${token}/visit`, { bearer: await asMember('bob', 'other') })).status).toBe(403)
    expect((await h.call('POST', `/v1/shares/${token}/visit`, { as: 'bob' })).status).toBe(403)
  })

  it('lets visitors wake a sleeping workspace only when the owner allowed it', async () => {
    const { h, sandbox, share, visit, settle } = await setup({ allowWake: true })
    await h.call('POST', `/v1/sandboxes/${sandbox.id}/suspend`)
    h.advance(LINK_CACHE_MS)
    const asleep = await visit(share.url)
    expect(asleep.status).toBe(503)
    expect(await asleep.text()).toContain('Wake workspace')
    expect((await visit(`${share.url}__orca/wake`, { method: 'POST' })).status).toBe(400)
    const woke = await visit(`${share.url}__orca/wake`, { method: 'POST', headers: { 'x-orca-wake': '1' } })
    expect(await woke.json()).toEqual({ state: 'waking' })
    await settle()
    expect(await (await visit(`${share.url}__orca/status`)).json()).toEqual({ state: 'ready', canWake: true })

    const other = await setup()
    await other.h.call('POST', `/v1/sandboxes/${other.sandbox.id}/suspend`)
    const noWake = await other.visit(other.share.url)
    expect(await noWake.text()).toContain('owner needs to open it in Orca')
    expect((await other.visit(`${other.share.url}__orca/wake`, { method: 'POST', headers: { 'x-orca-wake': '1' } })).status).toBe(403)

    // At most MAX_SHARE_WAKES_PER_DAY visitor wakes per workspace, whatever the link.
    for (let i = 0; i < MAX_SHARE_WAKES_PER_DAY; i++) {
      h.raw.prepare('INSERT INTO share_wakes (sandbox_id, share_id, at) VALUES (?, ?, ?)').run(sandbox.id, share.id, h.now())
    }
    await h.call('POST', `/v1/sandboxes/${sandbox.id}/suspend`)
    h.advance(WAKE_GAP_MS)
    const capped = await visit(`${share.url}__orca/wake`, { method: 'POST', headers: { 'x-orca-wake': '1' } })
    expect(capped.status).toBe(429)
  })

  it('adds the proxy port to a sandbox created before share links', async () => {
    const { h, share, visit } = await setup()
    const box = [...h.vercel.boxes.values()][0]!
    box.ports = [6768]
    box.sessionId = `${box.sessionId}`
    // A new session id (fresh route cache) on the same box: resume after a suspend.
    await h.call('POST', `/v1/sandboxes/${share.sandboxId}/suspend`)
    box.ports = [6768]
    await h.call('POST', `/v1/sandboxes/${share.sandboxId}/resume`)
    expect(box.ports).toEqual([6768])
    h.advance(LINK_CACHE_MS)
    await visit(share.url)
    expect(box.ports).toEqual([6768, 6769])
  })

  it('turns off every link when the workspace is deleted', async () => {
    const { h, sandbox, share, visit } = await setup()
    await h.call('DELETE', `/v1/sandboxes/${sandbox.id}`)
    h.advance(LINK_CACHE_MS)
    expect((await visit(share.url)).status).toBe(410)
  })
})
