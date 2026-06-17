import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboundMatrixMessage } from './types'

// ── Fake matrix-bot-sdk client ───────────────────────────────────────────
// Captures listeners and calls so the test can drive 'room.message' events and
// assert send/stop wiring without a real homeserver or the native crypto binary.
type RoomMessageListener = (roomId: string, event: RawEvent) => void

type RawEvent = {
  event_id?: string
  sender?: string
  origin_server_ts?: number
  content?: Record<string, unknown>
}

let lastFakeClient: FakeClient | null = null
let constructorArgs: unknown[] | null = null
// When set, the next FakeClient.start() rejects with this error.
let nextStartError: Error | null = null
let cryptoPrepareArgs: unknown = undefined
let joinedRoom: string | null = null

class FakeCrypto {
  async prepare(roomIds: string[]): Promise<void> {
    cryptoPrepareArgs = roomIds
  }
}

class FakeClient {
  args: unknown[]
  crypto = new FakeCrypto()
  listeners = new Map<string, RoomMessageListener[]>()
  started = false
  stopped = false
  startShouldThrow: Error | null = null
  sendMessageMock = vi.fn(async (_roomId: string, _content: unknown) => '$sent:server')
  userIdMock = vi.fn(async () => '@orca:server')
  profileMock = vi.fn(async () => ({ displayname: 'Orca Relay' }))

  constructor(...args: unknown[]) {
    this.args = args
    if (nextStartError) {
      this.startShouldThrow = nextStartError
      nextStartError = null
    }
  }

  async getUserId(): Promise<string> {
    return this.userIdMock()
  }

  on(event: string, listener: RoomMessageListener): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeAllListeners(): this {
    return this
  }

  async joinRoom(roomId: string): Promise<string> {
    joinedRoom = roomId
    return roomId
  }

  async start(): Promise<void> {
    if (this.startShouldThrow) {
      throw this.startShouldThrow
    }
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }

  async sendMessage(roomId: string, content: unknown): Promise<string> {
    return this.sendMessageMock(roomId, content)
  }

  async getUserProfile(): Promise<{ displayname?: string }> {
    return this.profileMock()
  }

  emitMessage(roomId: string, event: RawEvent): void {
    for (const listener of this.listeners.get('room.message') ?? []) {
      listener(roomId, event)
    }
  }
}

let tempHome = ''

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    event_id: '$evt:server',
    sender: '@someone:server',
    origin_server_ts: 1000,
    content: { msgtype: 'm.text', body: 'hello' },
    ...overrides
  }
}

async function loadClientModule() {
  vi.resetModules()
  constructorArgs = null
  lastFakeClient = null
  nextStartError = null
  cryptoPrepareArgs = undefined
  joinedRoom = null
  vi.doMock('electron', () => ({
    net: { fetch: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (v: string) => Buffer.from(v),
      decryptString: (v: Buffer) => v.toString('utf-8')
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  vi.doMock('matrix-bot-sdk', () => ({
    MatrixClient: class {
      constructor(...args: unknown[]) {
        constructorArgs = args
        lastFakeClient = new FakeClient(...args)
        return lastFakeClient
      }
    },
    SimpleFsStorageProvider: class {
      constructor(public file: string) {}
    },
    RustSdkCryptoStorageProvider: class {
      constructor(
        public dir: string,
        public storeType: number
      ) {}
    },
    RustSdkCryptoStoreType: { Sqlite: 0 }
  }))
  return import('./client')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-client-'))
  vi.restoreAllMocks()
})

const config = { homeserver: 'https://hs.server', userId: '@orca:server', roomId: '!room:server' }

describe('OrcaMatrixClient', () => {
  it('starts: constructs client with homeserver+token, prepares crypto, joins, syncs', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})

    // constructor(homeserverUrl, accessToken, storage, cryptoStore)
    expect(constructorArgs?.[0]).toBe('https://hs.server')
    expect(constructorArgs?.[1]).toBe('syt_token')
    expect(cryptoPrepareArgs).toEqual(['!room:server'])
    expect(joinedRoom).toBe('!room:server')
    expect(lastFakeClient?.started).toBe(true)
    expect(client.isRunning()).toBe(true)
  })

  it('derives device/user identity from the token (no minted device id)', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})
    // Identity comes from whoami; nothing in the constructor args names a device.
    expect(lastFakeClient?.userIdMock).toHaveBeenCalled()
    expect(JSON.stringify(constructorArgs)).not.toContain('device')
  })

  it('routes a live room message to onInbound', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const received: InboundMatrixMessage[] = []
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start((m) => received.push(m))

    lastFakeClient?.emitMessage(
      '!room:server',
      makeEvent({ content: { msgtype: 'm.text', body: 'hi orca' } })
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      eventId: '$evt:server',
      roomId: '!room:server',
      sender: '@someone:server',
      body: 'hi orca',
      ts: 1000
    })
  })

  it('extracts html and reply relation from inbound content', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const received: InboundMatrixMessage[] = []
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start((m) => received.push(m))

    lastFakeClient?.emitMessage(
      '!room:server',
      makeEvent({
        content: {
          msgtype: 'm.text',
          body: 'reply body',
          format: 'org.matrix.custom.html',
          formatted_body: '<b>reply</b>',
          'm.relates_to': { 'm.in_reply_to': { event_id: '$parent:server' } }
        }
      })
    )
    expect(received[0]).toMatchObject({
      html: '<b>reply</b>',
      inReplyToEventId: '$parent:server'
    })
  })

  it('ignores own echoes and other rooms', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const received: InboundMatrixMessage[] = []
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start((m) => received.push(m))

    // Own echo: sender equals the relay's whoami user id.
    lastFakeClient?.emitMessage('!room:server', makeEvent({ sender: '@orca:server' }))
    // Other room: filtered by roomId before dispatch.
    lastFakeClient?.emitMessage('!other:server', makeEvent({}))
    expect(received).toHaveLength(0)
  })

  it('sends a message and returns the event id', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})

    const result = await client.sendMessage('body text', { html: '<i>x</i>', inReplyTo: '$p' })
    expect(result).toEqual({ ok: true, eventId: '$sent:server' })
    const [roomId, content] = lastFakeClient!.sendMessageMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>
    ]
    expect(roomId).toBe('!room:server')
    expect(content).toMatchObject({
      msgtype: 'm.text',
      body: 'body text',
      format: 'org.matrix.custom.html',
      formatted_body: '<i>x</i>',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$p' } }
    })
  })

  it('returns a classified error when send fails', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})
    lastFakeClient!.sendMessageMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' })
    )

    const result = await client.sendMessage('x')
    expect(result).toEqual({ ok: false, error: 'forbidden: forbidden' })
  })

  it('returns not-running error when sending before start', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    const result = await client.sendMessage('x')
    expect(result).toEqual({ ok: false, error: 'Matrix client is not running' })
  })

  it('resolves the viewer via whoami + profile', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})
    const viewer = await client.getViewer()
    expect(viewer).toEqual({
      userId: '@orca:server',
      displayName: 'Orca Relay',
      homeserver: 'https://hs.server'
    })
  })

  it('throws a classified error and tears down when start fails', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    nextStartError = Object.assign(new Error('bad token'), { errcode: 'M_UNKNOWN_TOKEN' })
    const client = new OrcaMatrixClient(config, 'syt_token')

    await expect(client.start(() => {})).rejects.toThrow(/Matrix start failed \(auth\): bad token/)
    expect(client.isRunning()).toBe(false)
    expect(lastFakeClient?.stopped).toBe(true)
  })

  it('stops the client and clears running state', async () => {
    const { OrcaMatrixClient } = await loadClientModule()
    const client = new OrcaMatrixClient(config, 'syt_token')
    await client.start(() => {})
    await client.stop()
    expect(lastFakeClient?.stopped).toBe(true)
    expect(client.isRunning()).toBe(false)
  })
})
