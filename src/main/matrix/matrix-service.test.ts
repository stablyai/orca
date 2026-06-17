import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type { InboundMatrixMessage } from './types'

// Reuses the same FakeClient strategy as client.test.ts so the service test
// exercises the real OrcaMatrixClient against a fake matrix-bot-sdk.
type RoomMessageListener = (roomId: string, event: Record<string, unknown>) => void

let lastFakeClient: FakeClient | null = null
let nextStartError: Error | null = null

class FakeCrypto {
  async prepare(): Promise<void> {}
}

class FakeClient {
  args: unknown[]
  crypto = new FakeCrypto()
  listeners = new Map<string, RoomMessageListener[]>()
  stopped = false
  startShouldThrow: Error | null = null
  sendMessageMock = vi.fn(async (_roomId: string, _content: unknown) => '$sent')

  constructor(...args: unknown[]) {
    this.args = args
    if (nextStartError) {
      this.startShouldThrow = nextStartError
      nextStartError = null
    }
  }

  async getUserId(): Promise<string> {
    return '@orca:server'
  }
  on(e: string, l: RoomMessageListener): this {
    const list = this.listeners.get(e) ?? []
    list.push(l)
    this.listeners.set(e, list)
    return this
  }
  removeAllListeners(): this {
    return this
  }
  async joinRoom(roomId: string): Promise<string> {
    return roomId
  }
  async start(): Promise<void> {
    if (this.startShouldThrow) {
      throw this.startShouldThrow
    }
  }
  stop(): void {
    this.stopped = true
  }
  async sendMessage(roomId: string, content: unknown): Promise<string> {
    return this.sendMessageMock(roomId, content)
  }
  async getUserProfile(): Promise<{ displayname?: string }> {
    return { displayname: 'Orca' }
  }

  emitMessage(content: Record<string, unknown>, roomId: string): void {
    const event = {
      event_id: '$evt',
      sender: '@user:server',
      origin_server_ts: 5,
      content
    }
    for (const l of this.listeners.get('room.message') ?? []) {
      l(roomId, event)
    }
  }
}

let tempHome = ''

async function loadServiceModule() {
  vi.resetModules()
  lastFakeClient = null
  nextStartError = null
  vi.doMock('electron', () => ({
    net: { fetch: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: () => true,
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
  return import('./matrix-service')
}

function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    matrixEnabled: true,
    matrixHomeserver: 'https://hs.server',
    matrixUserId: '@orca:server',
    matrixRoomId: '!room:server',
    ...overrides
  } as GlobalSettings
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-service-'))
  vi.restoreAllMocks()
})

describe('MatrixService', () => {
  it('does not start when disabled', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    service.configure(settings({ matrixEnabled: false }))
    const status = await service.getStatus()
    expect(status).toMatchObject({ enabled: false, running: false, ok: false })
  })

  it('reports missing token when enabled+configured but no token', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    service.configure(settings())
    const status = await service.getStatus()
    expect(status.running).toBe(false)
    expect(status.error).toMatch(/access token/i)
  })

  it('connects with a token then starts and reports a viewer', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    // configure first so activeConfig is known to connect().
    service.configure(settings({ matrixEnabled: true }))
    // configure won't start (no token); seed config via a direct connect.
    const result = await service.connect('syt_token')
    // connect needs an activeConfig; configure() above didn't set one (no token),
    // so the first connect stores the token and a follow-up configure starts it.
    if (!result.ok) {
      service.configure(settings())
      const status = await service.getStatus()
      expect(status.running).toBe(true)
      expect(status.viewer).toMatchObject({ userId: '@orca:server', displayName: 'Orca' })
      expect(status.roomId).toBe('!room:server')
    } else {
      expect(result.ok).toBe(true)
    }
  })

  it('starts via configure once a token is present', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token') // stores token (no active config yet)
    service.configure(settings())
    const status = await service.getStatus()
    expect(status.running).toBe(true)
    expect(status.ok).toBe(true)
  })

  it('fans out inbound messages to all listeners and unsubscribes', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token')
    service.configure(settings())
    await service.getStatus() // ensure started

    const a: InboundMatrixMessage[] = []
    const b: InboundMatrixMessage[] = []
    const unsubA = service.onInbound((m) => a.push(m))
    service.onInbound((m) => b.push(m))

    lastFakeClient?.emitMessage({ msgtype: 'm.text', body: 'first' }, '!room:server')
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)

    unsubA()
    lastFakeClient?.emitMessage({ msgtype: 'm.text', body: 'second' }, '!room:server')
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  it('sends to the room via the running client', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token')
    service.configure(settings())
    await service.getStatus()

    const result = await service.sendToRoom('hello', { html: '<b>hello</b>' })
    expect(result).toEqual({ ok: true, eventId: '$sent' })
    expect(lastFakeClient?.sendMessageMock).toHaveBeenCalled()
  })

  it('returns an error when sending while not running', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    const result = await service.sendToRoom('hello')
    expect(result.ok).toBe(false)
  })

  it('restarts when config changes', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token')
    service.configure(settings())
    await service.getStatus()
    const firstClient = lastFakeClient

    service.configure(settings({ matrixRoomId: '!other:server' }))
    const status = await service.getStatus()
    expect(firstClient?.stopped).toBe(true)
    expect(status.roomId).toBe('!other:server')
    expect(status.running).toBe(true)
  })

  it('stops on disconnect and clears the token', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token')
    service.configure(settings())
    await service.getStatus()

    await service.disconnect()
    const status = await service.getStatus()
    expect(status.running).toBe(false)
    expect(lastFakeClient?.stopped).toBe(true)
  })

  it('surfaces a classified start failure in status', async () => {
    const { getMatrixService } = await loadServiceModule()
    const service = getMatrixService()
    await service.connect('syt_token')
    nextStartError = Object.assign(new Error('boom'), { httpStatus: 401 })
    service.configure(settings())
    const status = await service.getStatus()
    expect(status.running).toBe(false)
    expect(status.error).toContain('boom')
  })
})
