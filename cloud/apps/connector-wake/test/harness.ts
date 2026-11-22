// Shared by the protocol test and the spike: test wake tokens, the connector's signed admin call,
// and a local `wrangler dev` runner. Test keys only.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, type CryptoKey, type KeyObject } from 'jose'
import {
  CONNECTOR_WAKE_ADMIN_AUDIENCE,
  CONNECTOR_WAKE_ADMIN_OP,
  CONNECTOR_WAKE_ADMIN_PATH,
  CONNECTOR_WAKE_ADMIN_PURPOSE,
  CONNECTOR_WAKE_TOKEN_AUDIENCE,
  CONNECTOR_WAKE_TOKEN_PURPOSE
} from '../../../packages/connector-contract/src/wake-messages'

export type SigningKey = CryptoKey | KeyObject
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) { return true }
    await sleep(20)
  }
  return cond()
}

export const results: { name: string; ok: boolean; detail: string }[] = []
export function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

export type Host = { sub: string; mid: string; hostId: string }
export function newHost(sub = `acct-${randomBytes(6).toString('hex')}`): Host {
  const mid = randomBytes(18).toString('base64url')
  return { sub, mid, hostId: `${sub}:${mid}` }
}

export type MintOptions = { issuer?: string; audience?: string; purpose?: string; expiresIn?: string | number; kid?: string }
export async function mintWake(key: SigningKey, host: Host, opts: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT({ purpose: opts.purpose ?? CONNECTOR_WAKE_TOKEN_PURPOSE, mid: host.mid })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test' })
    .setSubject(host.sub)
    .setAudience(opts.audience ?? CONNECTOR_WAKE_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
  if (opts.issuer) { jwt.setIssuer(opts.issuer) }
  return jwt.sign(key)
}

// As the connector's publisher signs it: HS256, op, purpose, audience and the exact body's SHA-256.
export async function adminWake(
  origin: string,
  hosts: string[],
  auth: { key: string; issuer: string },
  tamper: { tokenBody?: string; op?: string; purpose?: string; audience?: string } = {}
): Promise<{ status: number; json: unknown }> {
  const body = JSON.stringify({ hosts })
  const bodySha256 = createHash('sha256').update(tamper.tokenBody ?? body).digest('base64url')
  const token = await new SignJWT({ purpose: tamper.purpose ?? CONNECTOR_WAKE_ADMIN_PURPOSE, op: tamper.op ?? CONNECTOR_WAKE_ADMIN_OP, bodySha256 })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(tamper.audience ?? CONNECTOR_WAKE_ADMIN_AUDIENCE)
    .setIssuer(auth.issuer)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(auth.key))
  const response = await fetch(`${origin}${CONNECTOR_WAKE_ADMIN_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

const running = new Set<ChildProcess>()
// Ends every dev server still running (for an overall timeout).
export function killAllDev(): void {
  for (const dev of running) {
    try {
      process.kill(-dev.pid!, 'SIGKILL')
    } catch {}
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as { port: number }
  await new Promise((r) => server.close(r))
  return port
}

// `wrangler dev` on a free port with the given vars, until /health answers.
export async function startDev(vars: Record<string, string>): Promise<{ origin: string; stop: () => Promise<void>; log: () => string }> {
  const cwd = new URL('..', import.meta.url).pathname
  const port = await freePort()
  const devVars = join(cwd, '.dev.vars')
  const devVarsBefore = existsSync(devVars) ? readFileSync(devVars) : null
  // Per run, in its own temp dir: a developer's .dev.vars is never read, written or removed.
  const stateDir = mkdtempSync(join(tmpdir(), 'connector-wake-dev-'))
  const envFile = join(stateDir, 'vars.env')
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'))
  const wrangler = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname
  // Its own process group, so stop() ends wrangler and workerd together.
  const dev: ChildProcess = spawn(wrangler, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(stateDir, 'state'), '--env-file', envFile], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  running.add(dev)
  let log = ''
  let exited = false
  dev.on('exit', () => (exited = true))
  dev.stdout?.on('data', (d) => (log += d))
  dev.stderr?.on('data', (d) => (log += d))
  const origin = `http://127.0.0.1:${port}`
  const stop = async () => {
    running.delete(dev)
    try {
      process.kill(-dev.pid!, 'SIGINT')
    } catch {}
    await sleep(1000)
    try {
      process.kill(-dev.pid!, 'SIGKILL')
    } catch {}
    rmSync(stateDir, { recursive: true, force: true })
    // Guard: a run must leave a developer's .dev.vars exactly as it found it.
    const devVarsAfter = existsSync(devVars) ? readFileSync(devVars) : null
    if (devVarsBefore === null ? devVarsAfter !== null : !devVarsAfter?.equals(devVarsBefore)) { throw new Error('startDev changed .dev.vars') }
  }
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) { break }
    } catch {}
    if (exited || i > 120) {
      await stop()
      throw new Error(`wrangler dev did not start:\n${log}`)
    }
    await sleep(500)
  }
  return { origin, stop, log: () => log }
}
