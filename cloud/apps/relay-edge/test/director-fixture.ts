// Test fixtures for the edge-native director endpoints: real HostRelay objects on node:sqlite
// behind a namespace stand-in, a relay JWT signer, and a WebSocketPair stand-in that bridges the
// Worker's server socket to a browser-style client socket (the phone's).
// Callers mock 'cloudflare:workers' and pass the HostRelay class in (vi.mock is per test file).
import { DatabaseSync } from 'node:sqlite'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { vi } from 'vitest'
import { nodeObjectSql } from './object-sqlite-fake'

export const EDGE_URL = 'https://edge.relay.example'
export const FRONT_DOOR_URL = 'https://cn.relay.example'
export const DIRECTOR_HOST = 'director-next.relay.example'
export const DIRECTOR_URL = `https://${DIRECTOR_HOST}`

// Every variable an object-backend Worker needs, without any DIRECTOR_* (today's environments).
export function baseEnv(jwks: string): Record<string, unknown> {
  return {
    EDGE_BACKEND: 'object',
    EDGE_CELL_ID: 'edge',
    ADMIN_SIGNING_KEY: 'k'.repeat(40),
    ADMIN_ISSUER: 'https://director.test.invalid',
    RELAY_JWKS: jwks,
    RELAY_JWT_AUDIENCE: 'orca-relay',
    PING_INTERVAL_MS: '30000',
    SILENCE_TIMEOUT_MS: '75000',
    ORPHAN_GRACE_MS: '30000'
  }
}

export const DIRECTOR_VARS = { DIRECTOR_HOSTNAME: DIRECTOR_HOST, DIRECTOR_EDGE_URL: EDGE_URL, DIRECTOR_FRONT_DOOR_URL: FRONT_DOOR_URL }

export type RelaySigner = { jwks: string; mint(claims: { user: string; host: string }): Promise<string> }

export async function relaySigner(): Promise<RelaySigner> {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const key: CryptoKey = pair.privateKey
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] })
  return {
    jwks,
    mint: ({ user, host }) =>
      new SignJWT({ prof: 'profile-1', relayHostId: host, purpose: 'host-control' })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setSubject(user)
        .setAudience('orca-relay')
        .setExpirationTime('5m')
        .sign(key)
  }
}

// A Durable Object's state on node:sqlite: SQL storage, KV storage, alarms, no sockets.
export function fakeObjectState() {
  const db = new DatabaseSync(':memory:')
  const kv = new Map<string, unknown>()
  let alarm: number | null = null
  let open = false
  const storage = {
    sql: nodeObjectSql(db),
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      if (open) { throw new Error('nested storage transaction') }
      open = true
      db.exec('BEGIN')
      try {
        const result = await operation()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        open = false
      }
    },
    get: async (key: string) => structuredClone(kv.get(key)),
    put: async (key: string, value: unknown) => {
      kv.set(key, structuredClone(value))
    },
    delete: async (key: string) => kv.delete(key),
    deleteAll: async () => {
      kv.clear()
      alarm = null
      const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => String(row.name))
      for (const name of names) { db.exec(`DROP TABLE "${name}"`) }
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at
    },
    deleteAlarm: async () => {
      alarm = null
    }
  }
  const ctx = {
    storage,
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null
  }
  const tables = () => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().length
  return { ctx, db, kv, tables }
}

// HOST_RELAY: one real object per name, created on first get (with the location hint it got).
export function hostNamespace<T>(create: (state: ReturnType<typeof fakeObjectState>['ctx']) => T) {
  const objects = new Map<string, { relay: T; state: ReturnType<typeof fakeObjectState> }>()
  const hints = new Map<string, string | undefined>()
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string, options?: { locationHint?: string }) => {
      let entry = objects.get(id)
      if (!entry) {
        const state = fakeObjectState()
        entry = { relay: create(state.ctx), state }
        objects.set(id, entry)
        hints.set(id, options?.locationHint)
      }
      return entry.relay
    }
  }
  return { namespace, objects, hints }
}

export function stubObjectGlobals(): void {
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        readonly request: string,
        readonly response: string
      ) {}
    }
  )
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void

// One end of a WebSocketPair, as the Worker uses it (accept, addEventListener, send, close).
export class FakeServerSocket {
  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null
  private readonly listeners = new Map<string, Listener[]>()
  // The client end: frames and the close go to the phone's socket.
  peer: { deliver(data: string): void; closedBy(code: number, reason: string): void } | null = null

  accept(): void {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) { listener(event) }
  }

  send(data: string): void {
    if (this.closed) { throw new Error('closed') }
    this.sent.push(data)
    this.peer?.deliver(data)
  }

  close(code: number, reason: string): void {
    if (this.closed) { return }
    this.closed = { code, reason }
    this.peer?.closedBy(code, reason)
    this.dispatch('close', { code, reason })
  }
}

// WebSocketPair and a Response that can carry a 101 (Node's refuses statuses below 200).
export function stubUpgradeGlobals(): FakeServerSocket[] {
  const servers: FakeServerSocket[] = []
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0: { kind: 'client'; server: FakeServerSocket }
      1: FakeServerSocket
      constructor() {
        const server = new FakeServerSocket()
        servers.push(server)
        this[0] = { kind: 'client', server }
        this[1] = server
      }
    }
  )
  const Base = Response
  vi.stubGlobal(
    'Response',
    class extends Base {
      readonly upgraded: boolean
      readonly webSocket: unknown
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init)
        this.upgraded = init?.status === 101
        this.webSocket = init?.webSocket ?? null
      }

      get status(): number {
        return this.upgraded ? 101 : super.status
      }
    }
  )
  return servers
}

type PhoneSocket = {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string): void
  close(): void
}

function serverOf(response: Response): FakeServerSocket | null {
  const socket: unknown = Reflect.get(response, 'webSocket')
  const server: unknown = typeof socket === 'object' && socket !== null ? Reflect.get(socket, 'server') : null
  return server instanceof FakeServerSocket ? server : null
}

// The phone's `createSocket`: dials the Worker (wss -> an https upgrade request) and wires the
// browser-style socket the shipped client drives to the Worker's server socket.
export function phoneSocketFactory(fetch: (input: string, init?: RequestInit) => Promise<Response>): (url: string) => PhoneSocket {
  return (url) => {
    let server: FakeServerSocket | null = null
    const socket: PhoneSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (data) => server?.dispatch('message', { data }),
      close: () => {}
    }
    void fetch(url.replace(/^wss:/, 'https:'), { headers: { upgrade: 'websocket' } }).then((response) => {
      server = response.status === 101 ? serverOf(response) : null
      if (!server) {
        socket.onclose?.({ code: 1006 })
        return
      }
      server.peer = { deliver: (data) => socket.onmessage?.({ data }), closedBy: (code) => socket.onclose?.({ code }) }
      socket.onopen?.()
    })
    return socket
  }
}
