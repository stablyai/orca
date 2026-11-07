import nacl from 'tweetnacl'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import { DesktopMobileE2EEV2Session } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import { loadIrohHomeRelayUrl, saveIrohHomeRelayUrl } from '../storage/preferences'
import {
  loadStoredHostProfiles,
  toStoredHostProfile,
  writeStoredHostProfiles
} from './host-metadata-store'
import { openIrohRpcClient } from './mobile-iroh-physical-link'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { connect, type RpcClient } from './rpc-client'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile, RpcRequest } from './types'

const storage = new Map<string, string>()
let relayWriteGate: Promise<void> | null = null
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (key === 'orca:irohHomeRelayUrl') {
        await relayWriteGate
      }
      storage.set(key, value)
    },
    removeItem: async (key: string) => void storage.delete(key)
  }
}))
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('./expo-iroh-native-module', () => ({
  loadExpoIroh: () => native,
  expoIrohModuleLoads: () => true
}))

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

type Identity = { profile: HostProfile; secretKey: Uint8Array }

// Only the wire boundary is simulated; clients use real v2 crypto, authentication and stream registries.
class DesktopPeer {
  session: DesktopMobileE2EEV2Session | null = null
  authenticated = false
  closed = false
  readonly requests: RpcRequest[] = []
  readonly streams = new Map<string, string>()

  constructor(
    readonly identity: Identity,
    readonly path: 'iroh' | 'websocket' | 'relay',
    readonly homeRelayUrl: string | null,
    readonly deliver: (frame: string) => void
  ) {}

  receive(frame: string): void {
    expect(this.closed).toBe(false)
    if (!this.session) {
      this.session = DesktopMobileE2EEV2Session.create({
        hello: JSON.parse(frame),
        serverSecretKey: this.identity.secretKey,
        expectedContext:
          this.path === 'relay'
            ? { transport: 'relay', relayHostId: relay.relayHostId }
            : { transport: 'direct' }
      })
      expect(this.session).not.toBeNull()
      this.reply(JSON.stringify(this.session!.ready))
      return
    }
    const plaintext = this.session.openText(frame)
    expect(plaintext).not.toBeNull()
    if (!this.authenticated) {
      expect(JSON.parse(plaintext!)).toEqual({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64: this.session.transcriptHashB64,
        deviceToken: this.identity.profile.deviceToken
      })
      this.authenticated = true
      this.seal({
        type: 'e2ee_authenticated',
        v: 2,
        transcriptHashB64: this.session.transcriptHashB64
      })
      return
    }
    const request: RpcRequest & { params: { subscriptionId: string } } = JSON.parse(plaintext!)
    expect(request.deviceToken).toBe(this.identity.profile.deviceToken)
    this.requests.push(request)
    if (
      request.method === 'runtime.clientEvents.subscribe' ||
      request.method === 'browser.screencast'
    ) {
      const subscriptionId = `${this.identity.profile.id}-${this.streams.size + 1}`
      this.streams.set(subscriptionId, request.id)
      this.seal({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId }
      })
    } else if (request.method === 'runtime.clientEvents.unsubscribe') {
      expect(this.streams.delete(request.params.subscriptionId)).toBe(true)
    } else {
      const result =
        request.method === 'pairing.getEndpoints'
          ? {
              v: 1,
              relay,
              resumeConfirmation: {
                v: 1,
                reqId: 'confirm-1',
                currentVersion: 3,
                acceptedAs: 'current',
                renewed: true,
                resumeExpiresAt: Date.now() + 300_000
              }
            }
          : { path: this.path, homeRelayUrl: this.homeRelayUrl }
      this.seal({ id: request.id, ok: true, result })
    }
  }

  emit(sequence: number): void {
    expect(this.authenticated).toBe(true)
    expect(this.closed).toBe(false)
    expect(this.streams.size).toBe(1)
    for (const id of this.streams.values()) {
      this.seal({ id, ok: true, streaming: true, result: { type: 'event', sequence } })
    }
  }

  private seal(value: unknown): void {
    this.reply(this.session!.sealText(JSON.stringify(value)))
  }

  private reply(frame: string): void {
    void Promise.resolve().then(() => {
      if (!this.closed) {
        this.deliver(frame)
      }
    })
  }
}

const nativeIdentities = new Map<string, Identity>()
const nativePeers = new Map<string, DesktopPeer>()
const messageListeners = new Set<(event: { connectionId: string; bytesBase64: string }) => void>()
const closedListeners = new Set<(event: { connectionId: string; reason: string }) => void>()
let boundHomeRelayUrl: string | null = null
let nextConnectionId = 0
let nativeSendGate: { entered: () => void; wait: Promise<void> } | null = null
const native = {
  irohStart: async (homeRelayUrl: string | null) => {
    boundHomeRelayUrl = homeRelayUrl
    return { endpointId: 'f'.repeat(64) }
  },
  irohConnect: async (
    endpointId: string,
    hints: { relayUrl: string | null; directAddresses: string[] }
  ) => {
    const identity = nativeIdentities.get(endpointId)!
    expect(hints).toEqual({
      relayUrl: identity.profile.iroh!.relayUrl,
      directAddresses: identity.profile.iroh!.directAddresses
    })
    const connectionId = `connection-${++nextConnectionId}`
    nativePeers.set(
      connectionId,
      new DesktopPeer(identity, 'iroh', boundHomeRelayUrl, (frame) => {
        for (const listener of messageListeners) {
          listener({ connectionId, bytesBase64: Buffer.from(frame).toString('base64') })
        }
      })
    )
    return { connectionId }
  },
  irohSend: async (connectionId: string, bytesBase64: string) => {
    const gate = nativeSendGate
    nativeSendGate = null
    if (gate) {
      gate.entered()
      await gate.wait
    }
    nativePeers.get(connectionId)!.receive(Buffer.from(bytesBase64, 'base64').toString('utf8'))
  },
  irohClose: async (connectionId: string) => {
    nativePeers.get(connectionId)!.closed = true
  },
  irohStop: async () => {
    for (const [connectionId, peer] of nativePeers) {
      if (peer.closed) {
        continue
      }
      peer.closed = true
      for (const listener of closedListeners) {
        listener({ connectionId, reason: 'stopped' })
      }
    }
  },
  onIrohMessage: (listener: (event: { connectionId: string; bytesBase64: string }) => void) => {
    messageListeners.add(listener)
    return { remove: () => messageListeners.delete(listener) }
  },
  onIrohClosed: (listener: (event: { connectionId: string; reason: string }) => void) => {
    closedListeners.add(listener)
    return { remove: () => closedListeners.delete(listener) }
  },
  onIrohPathChanged: (listener: unknown) => {
    const listeners = new Set([listener])
    return { remove: () => listeners.delete(listener) }
  }
}

class WireSocket {
  static readonly OPEN = 1
  readonly OPEN = 1
  readyState = 0
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  readonly peer: DesktopPeer
  close = vi.fn(() => {
    this.readyState = 3
    this.peer.closed = true
    this.onclose?.({ code: 1000, reason: 'client_close' })
  })

  constructor(
    identity: Identity,
    readonly path: 'websocket' | 'relay'
  ) {
    this.peer = new DesktopPeer(identity, path, null, (data) => this.onmessage?.({ data }))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  send(frame: string): void {
    if (this.path === 'relay' && !this.peer.session) {
      const auth: unknown = JSON.parse(frame)
      if (auth && typeof auth === 'object' && 'type' in auth && auth.type === 'relay-auth') {
        expect(auth).toEqual({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: 'resume-secret'
        })
        this.onmessage?.({
          data: JSON.stringify({
            type: 'relay-hello',
            ok: true,
            credentialKind: 'resume',
            leaseExpiresAt: Date.now() + 60_000,
            acceptedCredentialVersion: 3,
            acceptedAs: 'current',
            resumeExpiresAt: Date.now() + 300_000
          })
        })
        return
      }
    }
    this.peer.receive(frame)
  }
}

function webSocket(socket: WireSocket): WebSocket {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the socket surface consumed by both real RPC transports.
  return socket as unknown as WebSocket
}

const clients: RpcClient[] = []
afterEach(() => {
  for (const client of clients) {
    client.close()
  }
  clients.length = 0
  nativeIdentities.clear()
  nativePeers.clear()
  nativeSendGate = null
  storage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('durably saves the phone relay, reconnects both Iroh facades with authenticated stream replay, and leaves other live paths and pairings alone', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', WireSocket)
  const identities: Identity[] = Array.from({ length: 4 }, (_, index) => {
    const keys = nacl.box.keyPair()
    return {
      secretKey: keys.secretKey,
      profile: {
        id: `host-${index}`,
        name: `Desktop ${index}`,
        endpoint: `ws://desktop-${index}.invalid`,
        deviceToken: `device-${index}`,
        publicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
        lastConnected: 1,
        ...(index < 2
          ? {
              iroh: {
                endpointId: String(index + 1).repeat(64),
                relayUrl: `https://desktop-${index}.relay.invalid/`,
                directAddresses: [`192.168.1.${index + 2}:41234`]
              }
            }
          : {})
      }
    }
  })
  await writeStoredHostProfiles(identities.map(({ profile }) => toStoredHostProfile(profile)))
  const storedHosts = await loadStoredHostProfiles()
  expect(storedHosts).toHaveLength(4)
  const pairedSnapshot = storage.get('orca:hosts')
  const irohClients = storedHosts!.slice(0, 2).map((host, index) => {
    const identity = identities[index]!
    nativeIdentities.set(host.iroh!.endpointId, identity)
    const physical = openIrohRpcClient({
      desktopEndpointId: host.iroh!.endpointId,
      dialHints: { relayUrl: host.iroh!.relayUrl!, directAddresses: host.iroh!.directAddresses! },
      deviceToken: identity.profile.deviceToken,
      publicKeyB64: host.publicKeyB64
    })
    expect(physical).not.toBeNull()
    return createStableLogicalRpcClient(physical!, 'iroh')
  })
  clients.push(...irohClients)
  const wsSocket = new WireSocket(identities[2]!, 'websocket')
  const wsClient = createStableLogicalRpcClient(
    connect(
      identities[2]!.profile.endpoint,
      identities[2]!.profile.deviceToken,
      identities[2]!.profile.publicKeyB64,
      { createSocket: () => webSocket(wsSocket) }
    ),
    'lan'
  )
  const relaySocket = new WireSocket(identities[3]!, 'relay')
  const relayClient = createStableLogicalRpcClient(
    connectMobileRelayRpcSession({
      relay,
      resumeToken: 'resume-secret',
      resumeCredentialVersion: 3,
      resumeConfirmReqId: 'confirm-1',
      deviceToken: identities[3]!.profile.deviceToken,
      desktopPublicKeyB64: identities[3]!.profile.publicKeyB64,
      createSocket: () => webSocket(relaySocket)
    }),
    'relay'
  )
  clients.push(wsClient, relayClient)
  wsSocket.open()
  relaySocket.open()
  await vi.advanceTimersByTimeAsync(0)
  expect(clients.map((client) => client.getState())).toEqual(Array(4).fill('connected'))

  const states: ConnectionState[][] = clients.map(() => [])
  const events = clients.map(() => vi.fn())
  const unsubscribe = clients.map((client, index) => {
    client.onStateChange((state) => states[index]!.push(state))
    return client.subscribe('runtime.clientEvents.subscribe', {}, events[index]!)
  })
  await vi.advanceTimersByTimeAsync(0)
  const originalIrohPeers = [...nativePeers.values()]
  expect(originalIrohPeers).toHaveLength(2)
  const originalPeers = [...originalIrohPeers, wsSocket.peer, relaySocket.peer]
  originalPeers.forEach((peer) => peer.emit(1))
  await vi.advanceTimersByTimeAsync(0)
  events.forEach((listener) =>
    expect(listener).toHaveBeenLastCalledWith({ type: 'event', sequence: 1 })
  )

  const commit = Promise.withResolvers<void>()
  relayWriteGate = commit.promise
  const selectedRelay = 'https://aps1-1.relay.n0.iroh.link./'
  const save = saveIrohHomeRelayUrl(selectedRelay)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.has('orca:irohHomeRelayUrl')).toBe(false)
    expect(originalPeers.every((peer) => !peer.closed)).toBe(true)
    expect(states).toEqual([[], [], [], []])
    commit.resolve()
    await save
    expect(storage.get('orca:irohHomeRelayUrl')).toBe(selectedRelay)
    await expect(loadIrohHomeRelayUrl()).resolves.toBe(selectedRelay)
    expect(irohClients.map((client) => client.getState())).toEqual(['reconnecting', 'reconnecting'])
    expect(originalIrohPeers.every((peer) => peer.closed)).toBe(true)
    expect(wsSocket.close).not.toHaveBeenCalled()
    expect(relaySocket.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients.map((client) => client.getState())).toEqual(Array(4).fill('connected'))
    irohClients.forEach((client, index) => {
      expect(client.getGeneration()).toBe(1)
      expect(client.getActivePath()).toBe('iroh')
      expect(states[index]).toEqual(['reconnecting', 'connecting', 'handshaking', 'connected'])
    })
    expect(states.slice(2)).toEqual([[], []])
    const replacements = [...nativePeers.values()].filter((peer) => !peer.closed)
    expect(replacements).toHaveLength(2)
    expect(nativePeers.size).toBe(4)
    replacements.forEach((peer) => {
      expect(peer.authenticated).toBe(true)
      expect(peer.homeRelayUrl).toBe(selectedRelay)
      expect(peer.requests.map((request) => request.method)).toEqual([
        'runtime.clientCapabilities.update',
        'runtime.clientEvents.subscribe'
      ])
    })
    const activePeers = [...replacements, wsSocket.peer, relaySocket.peer]
    activePeers.forEach((peer) => peer.emit(2))
    await vi.advanceTimersByTimeAsync(0)
    events.forEach((listener, index) => {
      expect(listener).toHaveBeenLastCalledWith({ type: 'event', sequence: 2 })
      expect(listener.mock.calls.filter(([event]) => event.type === 'ready')).toHaveLength(
        index < 2 ? 2 : 1
      )
    })
    const responses = await Promise.all(
      clients.map((client) => client.sendRequest('status.get', {}))
    )
    expect(responses.map((response) => response.ok && response.result)).toEqual([
      { path: 'iroh', homeRelayUrl: selectedRelay },
      { path: 'iroh', homeRelayUrl: selectedRelay },
      { path: 'websocket', homeRelayUrl: null },
      { path: 'relay', homeRelayUrl: null }
    ])
    expect(storage.get('orca:hosts')).toBe(pairedSnapshot)
    await expect(loadStoredHostProfiles()).resolves.toEqual(storedHosts)
    expect(wsSocket.close).not.toHaveBeenCalled()
    expect(relaySocket.close).not.toHaveBeenCalled()
    unsubscribe.forEach((dispose) => dispose())
    await vi.advanceTimersByTimeAsync(0)
    activePeers.forEach((peer) => expect(peer.streams.size).toBe(0))
  } finally {
    commit.resolve()
    relayWriteGate = null
    await save
  }
})

it('delivers encrypted RPC bursts in issue order while a native send is pending and receives native binary screencast frames', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', WireSocket)
  const keys = nacl.box.keyPair()
  const identity: Identity = {
    secretKey: keys.secretKey,
    profile: {
      id: 'ordered-host',
      name: 'Ordered desktop',
      endpoint: 'ws://ordered.invalid',
      deviceToken: 'ordered-device',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
      lastConnected: 1,
      iroh: {
        endpointId: '5'.repeat(64),
        relayUrl: 'https://desktop.relay.invalid/',
        directAddresses: []
      }
    }
  }
  const target = identity.profile.iroh!
  nativeIdentities.set(target.endpointId, identity)
  const client = openIrohRpcClient({
    desktopEndpointId: target.endpointId,
    dialHints: { relayUrl: target.relayUrl, directAddresses: target.directAddresses },
    deviceToken: identity.profile.deviceToken,
    publicKeyB64: identity.profile.publicKeyB64
  })
  expect(client).not.toBeNull()
  clients.push(client!)
  await vi.advanceTimersByTimeAsync(0)
  expect(client!.getState()).toBe('connected')
  const [connectionId, host] = [...nativePeers].find(([, peer]) => peer.identity === identity)!
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  nativeSendGate = { entered: entered.resolve, wait: release.promise }
  const first = client!.sendRequest('status.get', { payload: 'x'.repeat(40 * 1024) })
  try {
    await entered.promise
    const replies = Promise.allSettled([
      first,
      client!.sendRequest('worktree.ps', { limit: 1 }),
      client!.sendRequest('worktree.create', { name: 'ordered' })
    ])
    await vi.advanceTimersByTimeAsync(0)
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.requests.map((request) => request.method)).toEqual([
      'runtime.clientCapabilities.update',
      'status.get',
      'worktree.ps',
      'worktree.create'
    ])
    expect(host.requests[1]!.params).toEqual({ payload: 'x'.repeat(40 * 1024) })
    const responses = await replies
    expect(
      responses.map(
        (response) => response.status === 'fulfilled' && response.value.ok && response.value.result
      )
    ).toEqual([
      { path: 'iroh', homeRelayUrl: null },
      { path: 'iroh', homeRelayUrl: null },
      { path: 'iroh', homeRelayUrl: null }
    ])
  } finally {
    release.resolve()
  }

  const onBinaryFrame = vi.fn()
  client!.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
  await vi.advanceTimersByTimeAsync(0)
  const binary = host.session!.sealBinary(
    encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 9,
      format: 'jpeg',
      metadata: { imageWidth: 800 },
      image: new Uint8Array([0xff, 0xd8, 0xff])
    })
  )
  for (const listener of messageListeners) {
    listener({ connectionId, bytesBase64: Buffer.from(binary).toString('base64') })
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(onBinaryFrame).toHaveBeenCalledWith({
    opcode: 1,
    seq: 9,
    format: 'jpeg',
    metadata: { imageWidth: 800 },
    image: new Uint8Array([0xff, 0xd8, 0xff])
  })
})

it.each(['Transport closed', 'Iroh send failed'])(
  'rejects pending encrypted RPCs and authenticates a replacement after native write failure when %s logging throws',
  async (throwingMessage) => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', WireSocket)
    const keys = nacl.box.keyPair()
    const identity: Identity = {
      secretKey: keys.secretKey,
      profile: {
        id: 'recovering-host',
        name: 'Recovering desktop',
        endpoint: 'ws://recovering.invalid',
        deviceToken: 'recovering-device',
        publicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
        lastConnected: 1,
        iroh: {
          endpointId: '6'.repeat(64),
          relayUrl: 'https://desktop.relay.invalid/',
          directAddresses: []
        }
      }
    }
    const target = identity.profile.iroh!
    nativeIdentities.set(target.endpointId, identity)
    const logs: string[] = []
    const client = openIrohRpcClient({
      desktopEndpointId: target.endpointId,
      dialHints: { relayUrl: target.relayUrl, directAddresses: target.directAddresses },
      deviceToken: identity.profile.deviceToken,
      publicKeyB64: identity.profile.publicKeyB64,
      onLog: (entry) => {
        logs.push(entry.message)
        if (entry.message === throwingMessage) {
          throw new Error('diagnostic sink failed')
        }
      }
    })
    expect(client).not.toBeNull()
    clients.push(client!)
    await vi.advanceTimersByTimeAsync(0)
    expect(client!.getState()).toBe('connected')
    const original = [...nativePeers.values()].find((peer) => peer.identity === identity)!
    const states: ConnectionState[] = []
    client!.onStateChange((state) => states.push(state))
    const entered = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    nativeSendGate = { entered: entered.resolve, wait: failed.promise }
    const pending = Promise.allSettled([
      client!.sendRequest('status.get', {}),
      client!.sendRequest('worktree.ps', { limit: 1 })
    ])
    await entered.promise
    await vi.advanceTimersByTimeAsync(0)
    failed.reject(new Error('native write failed'))
    await vi.advanceTimersByTimeAsync(0)

    expect(logs).toContain(throwingMessage)
    expect(await pending).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: 'Connection interrupted' })
      },
      { status: 'rejected', reason: expect.objectContaining({ message: 'Connection interrupted' }) }
    ])
    for (const result of await pending) {
      expect(result.status === 'rejected' && isRpcDeliveryUnknown(result.reason)).toBe(true)
    }
    expect(original.closed).toBe(true)
    expect(original.requests.map((request) => request.method)).toEqual([
      'runtime.clientCapabilities.update'
    ])
    expect(client!.getState()).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(states).toEqual(['reconnecting', 'connecting', 'handshaking', 'connected'])
    const replacement = [...nativePeers.values()].find(
      (peer) => peer.identity === identity && !peer.closed
    )!
    expect(replacement).not.toBe(original)
    expect(replacement.authenticated).toBe(true)
    await expect(client!.sendRequest('status.get', {})).resolves.toEqual({
      id: expect.any(String),
      ok: true,
      result: { path: 'iroh', homeRelayUrl: null }
    })
    expect(replacement.requests.map((request) => request.method)).toEqual([
      'runtime.clientCapabilities.update',
      'status.get'
    ])
  }
)
