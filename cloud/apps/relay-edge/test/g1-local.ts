// Dry run of test/g1-front-door.ts on localhost: wrangler dev over https with token-mode ingress
// config, behind a tiny emulation of the load balancer (static token header, client address and
// country headers, Host override to the edge, 404 for admin routes, `via: 1.1 google`). Proves the
// G1 script and the token path end to end before anyone touches staging.
//   npx tsx test/g1-local.ts            (G1_HOLD_MS defaults to 20 s here)
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer, request } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { jwksOf, loadOrCreateKeys } from '../spike/lib'

const EDGE_PORT = 8789
const FRONT_PORT = 8463
const EDGE = `https://127.0.0.1:${EDGE_PORT}`
const FRONT = `https://localhost:${FRONT_PORT}`
const TOKEN = randomBytes(32).toString('base64url')
const ADMIN_KEY = randomBytes(36).toString('base64url')
const ADMIN_ISSUER = 'https://director.test.invalid'

if (!process.env.G1_LOCAL_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-g1-local-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
    stdio: 'inherit',
    env: { ...process.env, G1_LOCAL_DIR: dir, NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') }
  })
  child.on('exit', (code) => {
    rmSync(dir, { recursive: true, force: true })
    process.exit(code ?? 1)
  })
} else {
  void run()
}

// What the load balancer adds. Client copies of these names are overwritten, as the LB does.
function lbHeaders(raw: string[], clientIp: string): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < raw.length; i += 2) if (!/^(host|x-orca-.*)$/i.test(raw[i]!)) out.push([raw[i]!, raw[i + 1]!])
  return out.concat([
    ['host', `127.0.0.1:${EDGE_PORT}`],
    ['x-orca-ingress', `v1s cn ${FRONT} ${TOKEN}`],
    ['x-orca-client-ip', clientIp.replace(/^::ffff:/, '')],
    ['x-orca-client-country', 'CN']
  ])
}

function frontDoor(dir: string) {
  const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
  const blocked = (path = '') => /^\/(__admin|__spike)\//.test(path)
  const server = createServer(tls, (req, res) => {
    if (blocked(req.url)) return void res.writeHead(404, { 'content-length': 0 }).end()
    const up = request({ host: '127.0.0.1', port: EDGE_PORT, method: req.method, path: req.url, headers: lbHeaders(req.rawHeaders, req.socket.remoteAddress ?? '').flat() }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, via: '1.1 google' })
      r.pipe(res)
    })
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  server.on('upgrade', (req, client: Socket, head: Buffer) => {
    if (blocked(req.url)) return void client.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n')
    const upstream = connect({ host: '127.0.0.1', port: EDGE_PORT })
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lbHeaders(req.rawHeaders, req.socket.remoteAddress ?? '').map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`)
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    upstream.on('close', () => client.end())
    client.on('close', () => upstream.end())
  })
  return server
}

async function run(): Promise<void> {
  const dir = process.env.G1_LOCAL_DIR!
  const keys = await loadOrCreateKeys()
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    [
      'EDGE_BACKEND=object',
      `ADMIN_SIGNING_KEY=${ADMIN_KEY}`,
      `ADMIN_ISSUER=${ADMIN_ISSUER}`,
      `RELAY_JWKS='${jwksOf(keys)}'`,
      `INGRESS_TOKENS=${TOKEN}`,
      `INGRESS_ORIGINS=${FRONT}`,
      // Local dev: the hop that reaches the Worker is this machine.
      'INGRESS_SOURCE_CIDRS=127.0.0.1/32,::1/128',
      'PING_INTERVAL_MS=3000',
      'SILENCE_TIMEOUT_MS=9000',
      'ORPHAN_GRACE_MS=4000'
    ].join('\n')
  )
  writeFileSync(join(dir, 'admin-key'), ADMIN_KEY)
  const stateDir = mkdtempSync(join(tmpdir(), 'relay-g1-local-state-'))
  const dev = spawn('npx', ['wrangler', 'dev', '--port', String(EDGE_PORT), '--ip', '127.0.0.1', '--persist-to', stateDir, '--local-protocol', 'https',
    '--https-key-path', join(dir, 'key.pem'), '--https-cert-path', join(dir, 'cert.pem')], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' })
  const front = frontDoor(dir)
  await new Promise<void>((r) => front.listen(FRONT_PORT, '127.0.0.1', () => r()))
  let code = 1
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${EDGE}/health`)).ok) break
      } catch {}
      if (i > 180) throw new Error('wrangler dev did not start')
      await new Promise((r) => setTimeout(r, 500))
    }
    const g1 = spawn(process.execPath, ['--import', 'tsx', new URL('./g1-front-door.ts', import.meta.url).pathname], {
      stdio: 'inherit',
      env: { ...process.env, G1_FRONT_DOOR: FRONT, G1_EDGE: EDGE, G1_ADMIN_KEY_FILE: join(dir, 'admin-key'), G1_ADMIN_ISSUER: ADMIN_ISSUER, G1_HOLD_MS: process.env.G1_HOLD_MS ?? '20000' }
    })
    code = await new Promise<number>((r) => g1.on('exit', (c) => r(c ?? 1)))
  } finally {
    front.close()
    dev.kill('SIGINT')
    await new Promise((r) => setTimeout(r, 500))
    rmSync(stateDir, { recursive: true, force: true })
    process.exit(code)
  }
}
