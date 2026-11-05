import { randomBytes as nodeRandomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopMobileE2EEV2Session } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value))
  }
}))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(nodeRandomBytes(length))
}))
vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

import {
  hydrateE2EEV2HostLatch,
  isHostLatchedToE2EEV2,
  latchHostToE2EEV2,
  resetE2EEV2HostLatchForTests
} from './e2ee-v2-host-latch'
import { connect } from './rpc-client'

const desktopKeys = nacl.box.keyPair()
const desktopPublicKeyB64 = Buffer.from(desktopKeys.publicKey).toString('base64')

class MockWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  readyState = 0
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: (string | Uint8Array)[] = []
  close = vi.fn(() => {
    if (this.readyState !== 3) {
      this.readyState = 3
      this.onclose?.()
    }
  })
  constructor(readonly endpoint: string) {
    sockets.push(this)
  }
  send(frame: string | Uint8Array): void {
    this.sent.push(frame)
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  receive(data: unknown): void {
    this.onmessage?.({ data })
  }
  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: '', wasClean: true })
  }
}

const sockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket
const flush = () => vi.advanceTimersByTimeAsync(0)

async function nextSocket(): Promise<MockWebSocket> {
  const count = sockets.length
  for (let elapsed = 0; sockets.length === count && elapsed < 60_000; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(sockets).toHaveLength(count + 1)
  return sockets.at(-1)!
}

function firstFrame(socket: MockWebSocket): unknown {
  return JSON.parse(String(socket.sent[0]))
}

function requestIdOf(plaintext: string | null): string {
  const value: unknown = JSON.parse(plaintext ?? 'null')
  expect(value).toEqual({
    id: expect.any(String),
    deviceToken: 'device-token',
    method: 'status.get',
    params: {}
  })
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('Expected the sealed request ID')
  }
  return value.id
}

// Plays the current host's direct v2 handshake with real crypto.
async function completeHostV2Handshake(socket: MockWebSocket): Promise<DesktopMobileE2EEV2Session> {
  const host = DesktopMobileE2EEV2Session.create({
    hello: firstFrame(socket),
    serverSecretKey: desktopKeys.secretKey,
    expectedContext: { transport: 'direct' }
  })
  expect(host).not.toBeNull()
  socket.receive(JSON.stringify(host!.ready))
  await flush()
  expect(JSON.parse(host!.openText(String(socket.sent[1]))!)).toEqual({
    type: 'e2ee_auth',
    v: 2,
    transcriptHashB64: host!.transcriptHashB64,
    deviceToken: 'device-token'
  })
  socket.receive(
    host!.sealText(
      JSON.stringify({
        type: 'e2ee_authenticated',
        v: 2,
        transcriptHashB64: host!.transcriptHashB64
      })
    )
  )
  await flush()
  return host!
}

describe('direct connections use E2EE v2 framing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    storage.clear()
    resetE2EEV2HostLatchForTests()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('sends a direct v2 hello, authenticates, and exchanges sealed RPC frames', async () => {
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    const socket = sockets[0]!
    socket.open()
    expect(firstFrame(socket)).toMatchObject({
      type: 'e2ee_hello',
      v: 2,
      context: { transport: 'direct' }
    })
    expect(firstFrame(socket)).not.toHaveProperty('publicKeyB64')

    const host = await completeHostV2Handshake(socket)
    expect(client.getState()).toBe('connected')

    const pending = client.sendRequest('status.get', {})
    await flush()
    const id = requestIdOf(host.openText(String(socket.sent.at(-1))))
    socket.receive(host.sealText(JSON.stringify({ id, ok: true, result: { up: 1 } })))
    await expect(pending).resolves.toMatchObject({ ok: true, result: { up: 1 } })
    expect(isHostLatchedToE2EEV2(desktopPublicKeyB64)).toBe(true)
    client.close()
  })

  it('falls back to legacy framing only for a never-latched host that refuses the v2 hello', async () => {
    await hydrateE2EEV2HostLatch()
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    sockets[0]!.open()
    sockets[0]!.serverClose(4001)
    await vi.advanceTimersByTimeAsync(2_000)

    const retry = sockets[1]!
    retry.open()
    expect(firstFrame(retry)).toEqual({ type: 'e2ee_hello', publicKeyB64: expect.any(String) })
    client.close()
  })

  it('never falls back to legacy for a host already seen speaking v2 (relay then LAN)', async () => {
    await hydrateE2EEV2HostLatch()
    latchHostToE2EEV2(desktopPublicKeyB64)
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    sockets[0]!.open()
    sockets[0]!.serverClose(4001)
    await vi.advanceTimersByTimeAsync(2_000)

    sockets[1]!.open()
    expect(firstFrame(sockets[1]!)).toMatchObject({ type: 'e2ee_hello', v: 2 })
    client.close()
  })

  it('refuses a legacy e2ee_ready answering its v2 hello and sends no credential', async () => {
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    const socket = sockets[0]!
    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    await flush()

    expect(socket.close).toHaveBeenCalled()
    expect(socket.sent).toHaveLength(1)
    expect(client.getState()).not.toBe('connected')
    client.close()
  })

  it('does not exhaust the auth budget on an old host while the latch store is still loading', async () => {
    let releaseStorage!: () => void
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage')
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
      () => new Promise((resolve) => (releaseStorage = () => resolve(null)))
    )
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    let socket = sockets[0]!
    for (let attempt = 0; attempt < 4; attempt++) {
      socket.open()
      expect(firstFrame(socket)).toMatchObject({ v: 2 })
      socket.serverClose(4001)
      socket = await nextSocket()
    }
    expect(client.getState()).not.toBe('auth-failed')

    releaseStorage()
    await flush()
    socket.serverClose(1006)
    socket = await nextSocket()
    socket.open()
    expect(firstFrame(socket)).toEqual({ type: 'e2ee_hello', publicKeyB64: expect.any(String) })
    client.close()
  })

  it('applies a latch recorded while a legacy dial was pending', async () => {
    await hydrateE2EEV2HostLatch()
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    sockets[0]!.open()
    sockets[0]!.serverClose(4001)
    await vi.advanceTimersByTimeAsync(2_000)

    // The retry chose legacy, but another connection proves v2 before this one opens.
    latchHostToE2EEV2(desktopPublicKeyB64)
    sockets[1]!.open()
    expect(firstFrame(sockets[1]!)).toMatchObject({ type: 'e2ee_hello', v: 2 })
    client.close()
  })

  it('sends no legacy credential when the host latches between hello and ready', async () => {
    await hydrateE2EEV2HostLatch()
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    sockets[0]!.open()
    sockets[0]!.serverClose(4001)
    await vi.advanceTimersByTimeAsync(2_000)
    const legacy = sockets[1]!
    legacy.open()
    expect(firstFrame(legacy)).toEqual({ type: 'e2ee_hello', publicKeyB64: expect.any(String) })

    latchHostToE2EEV2(desktopPublicKeyB64)
    legacy.receive(JSON.stringify({ type: 'e2ee_ready' }))
    await flush()
    expect(legacy.sent).toHaveLength(1)
    expect(legacy.close).toHaveBeenCalled()
    client.close()
  })

  it('latches auth-failed when a re-keyed host answers, as a legacy 4001 did', async () => {
    const client = connect('ws://desktop.invalid', 'device-token', desktopPublicKeyB64)
    const rekeyed = nacl.box.keyPair()
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await vi.advanceTimersByTimeAsync(2_000)
      }
      const socket = sockets.at(-1)!
      socket.open()
      const host = DesktopMobileE2EEV2Session.create({
        hello: firstFrame(socket),
        serverSecretKey: rekeyed.secretKey,
        expectedContext: { transport: 'direct' }
      })
      socket.receive(JSON.stringify(host!.ready))
      await flush()
      expect(socket.sent).toHaveLength(1)
    }
    expect(client.getState()).toBe('auth-failed')
    expect(isHostLatchedToE2EEV2(desktopPublicKeyB64)).toBe(false)
    client.close()
  })

  it('persists the latch so a later app session refuses to fall back', async () => {
    await hydrateE2EEV2HostLatch()
    latchHostToE2EEV2(desktopPublicKeyB64)
    await flush()
    resetE2EEV2HostLatchForTests()
    await hydrateE2EEV2HostLatch()
    expect(isHostLatchedToE2EEV2(desktopPublicKeyB64)).toBe(true)
  })
})
