// Shared helpers for the Cloudflare de-risk tools. Synthetic hosts run the SHIPPED desktop control
// client and data transport; phones speak the phone wire protocol directly. Test keys only.
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/control-channel/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/transports/relay-transport'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------- args / output ----------------

export function parseArgs(defaults: Record<string, string>): Record<string, string> {
  const out = { ...defaults }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/)
    if (!m) { continue }
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true')
  }
  return out
}

let eventFile: string | null = null
export function setEventFile(path: string | null): void {
  eventFile = path
}
// One JSON line per event, to stdout (unless quiet) and the --out file.
export function emit(event: Record<string, unknown>, quiet = false): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ...event })
  if (!quiet) { console.log(line) }
  if (eventFile) { appendFileSync(eventFile, `${line}\n`) }
}

export function pct(values: number[], p: number): number {
  if (values.length === 0) { return Number.NaN }
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

// ---------------- keys ----------------

export type SpikeKeys = { privateJwk: JWK; publicJwk: JWK; phoneToken: string; phoneTokenHash: string }
const KEYS_PATH = new URL('./.keys.json', import.meta.url) // gitignored

export async function loadOrCreateKeys(): Promise<SpikeKeys> {
  if (existsSync(KEYS_PATH)) { return JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as SpikeKeys }
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const phoneToken = randomBytes(32).toString('base64url')
  const keys: SpikeKeys = {
    privateJwk: { ...(await exportJWK(privateKey)), kid: 'spike', alg: 'ES256' },
    publicJwk: { ...(await exportJWK(publicKey)), kid: 'spike', alg: 'ES256', use: 'sig' },
    phoneToken,
    phoneTokenHash: createHash('sha256').update(phoneToken).digest('base64url')
  }
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}

export const jwksOf = (keys: SpikeKeys) => JSON.stringify({ keys: [keys.publicJwk] })
export const resumeHashesOf = (keys: SpikeKeys) => `resume:spike-phone:${keys.phoneTokenHash}`

async function mintJwt(keys: SpikeKeys, relayHostId: string, userId: string): Promise<string> {
  const key = await importJWK(keys.privateJwk, 'ES256')
  return new SignJWT({ purpose: 'host-control', prof: `prof-${userId}`, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: 'spike' })
    .setSubject(userId)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key)
}

// ---------------- synthetic host ----------------

export type HostEvent =
  | { kind: 'host_up'; host: number; generation: number; ms: number; rebind: boolean }
  | { kind: 'host_drop'; host: number; code: number }
  | { kind: 'host_connect_fail'; host: number; error: string }

export type SyntheticHost = {
  index: number
  relayHostId: string
  generation: number
  live: () => boolean
  stop: () => Promise<void>
}

export async function startHost(opts: {
  url: string
  keys: SpikeKeys
  index: number
  runTag: string
  reconnect: boolean
  onEvent: (e: HostEvent) => void
}): Promise<SyntheticHost> {
  // Deterministic per (runTag, index) so a restarted tool reuses the same objects.
  const seed = createHash('sha256').update(`${opts.runTag}:${opts.index}`).digest()
  const box = nacl.box.keyPair.fromSecretKey(new Uint8Array(seed))
  const relayHostId = createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16)
  const keypair = { publicKey: box.publicKey, secretKey: box.secretKey, publicKeyB64: Buffer.from(box.publicKey).toString('base64') }
  const userId = `spike-${opts.runTag}-${opts.index}`
  const identity = { userId, profileId: `prof-${userId}`, organizationId: '' }
  let stopped = false
  let client: RelayControlClient | null = null
  let transport: CloudRelayTransport | null = null
  let resume: { previousGeneration: number; controlResumeSecret: string } | undefined
  let up = false
  const host: SyntheticHost = {
    index: opts.index,
    relayHostId,
    generation: 0,
    live: () => client?.isLive() ?? false,
    stop: async () => {
      stopped = true
      client?.closeNow()
      await transport?.stop()
    }
  }

  const connect = async (attempt: number): Promise<void> => {
    if (stopped) { return }
    const started = Date.now()
    const relayJwt = await mintJwt(opts.keys, relayHostId, userId)
    const c: RelayControlClient = new RelayControlClient({
      cellUrl: opts.url,
      relayJwt,
      relayHostId,
      assignmentEpoch: 1,
      identity,
      keypair: keypair as never,
      appVersion: 'spike',
      ...(resume ?? {}),
      onConnectionOpen: (m) => void transport?.openConnection(m).catch(() => {}),
      onDrain: () => {},
      onClose: (code) => {
        // Only a session that came up counts as a drop; failed attempts are retried by retry().
        if (client !== c || stopped || !up) { return }
        up = false
        opts.onEvent({ kind: 'host_drop', host: opts.index, code })
        if (opts.reconnect) { void retry(0) }
      },
      createSocket: (url, token) =>
        new WebSocket(url, {
          headers: { authorization: `Bearer ${token}`, 'x-orca-host-capabilities': 'pending-conn-details,idle-regional-rehome-v1' },
          perMessageDeflate: false,
          maxPayload: 64 * 1024
        })
    })
    client = c
    const ack = await c.connect()
    up = true
    const rebind = resume !== undefined && ack.generation === resume.previousGeneration
    resume = { previousGeneration: ack.generation, controlResumeSecret: ack.controlResumeSecret }
    host.generation = ack.generation
    if (!transport || !rebind) {
      await transport?.stop()
      transport = new CloudRelayTransport({ cellUrl: opts.url, relayHostId, generation: ack.generation })
      // Echo: phones measure round trips through the host.
      transport.onMessage(((message: string | Uint8Array, reply: (r: string | Uint8Array) => void) => reply(message)) as never)
    }
    opts.onEvent({ kind: 'host_up', host: opts.index, generation: ack.generation, ms: Date.now() - started, rebind })
    void attempt
  }

  // Desktop-like: immediate first retry, then jittered exponential backoff capped at 30 s.
  const retry = async (attempt: number): Promise<void> => {
    if (stopped) { return }
    if (attempt > 0) { await sleep(Math.random() * Math.min(30_000, 1000 * 2 ** attempt)) }
    try {
      await connect(attempt)
    } catch (e) {
      opts.onEvent({ kind: 'host_connect_fail', host: opts.index, error: (e as Error).message })
      if (opts.reconnect) { return retry(attempt + 1) }
    }
  }
  await retry(0)
  return host
}

// ---------------- synthetic phone ----------------

export type PhoneStats = { rtts: number[]; sent: number; received: number; helloMs: number | null }

// Frame mix like "256:0.7,4096:0.25,65536:0.05" (bytes:weight).
export function parseMix(mix: string): { size: number; w: number }[] {
  return mix.split(',').map((p) => {
    const [size, w] = p.split(':').map(Number)
    return { size, w }
  })
}
function pickSize(mix: { size: number; w: number }[]): number {
  const total = mix.reduce((s, m) => s + m.w, 0)
  let r = Math.random() * total
  for (const m of mix) { if ((r -= m.w) <= 0) { return m.size } }
  return mix.at(-1).size
}

export function startPhone(opts: {
  url: string
  relayHostId: string
  token: string
  framesPerSec: number
  mix: { size: number; w: number }[]
  binaryShare: number
  onHello: (ok: boolean, ms: number, raw: unknown) => void
  onClose: (code: number, reason: string) => void
}): { stats: PhoneStats; close: () => void; ws: WebSocket } {
  const stats: PhoneStats = { rtts: [], sent: 0, received: 0, helloMs: null }
  const started = Date.now()
  const ws = new WebSocket(`${opts.url.replace(/^http/, 'ws')}/v1/connect/${opts.relayHostId}`, {
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024
  })
  let timer: NodeJS.Timeout | null = null
  let hello = false
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: opts.token })))
  ws.on('message', (raw, binary) => {
    if (!hello) {
      hello = true
      const parsed = JSON.parse(raw.toString())
      stats.helloMs = Date.now() - started
      // Real phones start their E2EE handshake right away; the shipped host transport drops a data
      // socket that receives nothing within attachDeadlineMs (10 s). Send one frame like it.
      if (parsed.ok === true) { sendFrame() }
      opts.onHello(parsed.ok === true, stats.helloMs, parsed)
      if (parsed.ok === true && opts.framesPerSec > 0) {
        timer = setInterval(() => sendFrame(), 1000 / opts.framesPerSec)
      }
      return
    }
    stats.received++
    const buf = binary ? (raw as Buffer) : Buffer.from(raw.toString())
    const sentAt = Number(buf.subarray(0, 13).toString())
    if (Number.isFinite(sentAt) && sentAt > 0) { stats.rtts.push(Date.now() - sentAt) }
  })
  ws.on('close', (code, reason) => {
    if (timer) { clearInterval(timer) }
    opts.onClose(code, reason.toString())
  })
  ws.on('error', () => {})
  const sendFrame = (): void => {
    if (ws.readyState !== WebSocket.OPEN) { return }
    const size = Math.max(16, pickSize(opts.mix))
    const head = String(Date.now()).padStart(13, '0')
    const binary = Math.random() < opts.binaryShare
    const body = Buffer.alloc(size, 0x61)
    body.write(head, 0)
    ws.send(binary ? body : body.toString(), { binary })
    stats.sent++
  }
  return {
    stats,
    ws,
    close: () => {
      if (timer) { clearInterval(timer) }
      ws.close(1000)
    }
  }
}

export async function edgeInfo(url: string): Promise<{ colo: string; version: string } | null> {
  try {
    const r = await fetch(`${url}/__spike/info`)
    return r.ok ? ((await r.json()) as { colo: string; version: string }) : null
  } catch {
    return null
  }
}

export async function hostInfo(url: string, relayHostId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${url}/__spike/host/${relayHostId}`)
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}
