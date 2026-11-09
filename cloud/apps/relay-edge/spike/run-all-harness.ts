// Shared constants and helpers for run-all.ts: result recording, the shipped desktop control
// client wrapper, the echo service, phone sockets and workerd memory sampling.
import { execSync } from 'node:child_process'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'

export const PORT = 8787
export const ORIGIN = `http://127.0.0.1:${PORT}`
export const PING_MS = 1500
export const SILENCE_MS = 5000
export const GRACE_MS = 4000
// GUARD=1 enables the per-splice silent-bytes flood guard (32 MiB per 10 s) for a second run.
export const GUARD = process.env.GUARD === '1'
export const GUARD_BYTES = 32 * 1024 * 1024
export const results: { name: string; ok: boolean; detail: string }[] = []
export const record = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

export type Ctx = {
  jwt: string
  keypair: { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string }
  identity: { userId: string; profileId: string; organizationId: string }
  relayHostId: string
  phoneToken: string
}

export function makeControl(
  ctx: Ctx,
  cellUrl: string,
  extra: { previousGeneration?: number; controlResumeSecret?: string } = {}
) {
  const events = { pings: 0, closes: [] as number[], opens: [] as unknown[] }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl,
    relayJwt: ctx.jwt,
    relayHostId: ctx.relayHostId,
    assignmentEpoch: 7,
    identity: ctx.identity,
    keypair: ctx.keypair as never,
    appVersion: 'spike',
    ...extra,
    onConnectionOpen: (m) => {
      events.opens.push(m)
      void transport?.openConnection(m)
    },
    onDrain: () => {},
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) => {
      // Same options as the shipped default, plus a tap to count server pings.
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-orca-host-capabilities': 'pending-conn-details,idle-regional-rehome-v1'
        },
        perMessageDeflate: false,
        maxPayload: 64 * 1024
      })
      ws.on('message', (raw, bin) => {
        if (!bin && JSON.parse(raw.toString()).type === 'ping') { events.pings++ }
      })
      return ws
    }
  })
  return {
    client,
    events,
    bindTransport: (generation: number) => {
      transport = new CloudRelayTransport({ cellUrl, relayHostId: ctx.relayHostId, generation })
      // Echo service: "big:<text|binary>:<bytes>" asks the host for a large frame.
      transport.onMessage(echo)
      return transport
    },
    echo: (...args: Parameters<typeof echo>) => echo(...args)
  }
}

export type Control = ReturnType<typeof makeControl>

export function echo(message: string | Uint8Array, reply: (r: string | Uint8Array) => void): void {
  if (typeof message === 'string' && message.startsWith('big:')) {
    const [, kind, size] = message.split(':')
    reply(kind === 'text' ? 'x'.repeat(Number(size)) : new Uint8Array(Number(size)).fill(7))
    return
  }
  reply(message)
}

export function openPhone(ctx: Ctx, origin = ORIGIN) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/v1/connect/${ctx.relayHostId}`, {
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024
  })
  const inbox: { data: Buffer | string; binary: boolean }[] = []
  let hello: unknown = null
  let closed: number | null = null
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: ctx.phoneToken }))
  )
  ws.on('message', (raw, binary) => {
    if (hello === null) {
      hello = JSON.parse(raw.toString())
      return
    }
    inbox.push({ data: binary ? (raw as Buffer) : raw.toString(), binary })
  })
  ws.on('close', (code) => (closed = code))
  return {
    ws,
    inbox,
    get hello() {
      return hello
    },
    get closed() {
      return closed
    }
  }
}

export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) { return true }
    await sleep(20)
  }
  return cond()
}

export function workerdRssMb(): number {
  try {
    const out = execSync("ps -axo rss=,command= | grep -i '[w]orkerd serve' || true").toString()
    return Math.round(
      out
        .split('\n')
        .filter(Boolean)
        .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0) / 1024
    )
  } catch {
    return -1
  }
}
