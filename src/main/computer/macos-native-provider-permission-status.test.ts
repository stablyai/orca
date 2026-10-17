import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock, spawnMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('fs', () => ({
  chmodSync: vi.fn(),
  mkdtempSync: vi.fn((prefix: string) => `${prefix}fixture`),
  rmSync: vi.fn(),
  writeFileSync: vi.fn()
}))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseExecutablePath: () =>
    '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
}))
vi.mock('./macos-native-provider-socket', () => ({ connectMacOSProviderSocket: connectMock }))

type Replies = Record<string, unknown>

// Answers each request line with the reply configured for its method.
class AutoReplySocket extends EventEmitter {
  destroyed = false
  methods: string[] = []

  constructor(private readonly replies: Replies) {
    super()
  }

  setEncoding(): void {}

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    const request: { id: number; method: string } = JSON.parse(line)
    this.methods.push(request.method)
    callback?.(null)
    if (request.method in this.replies) {
      queueMicrotask(() =>
        this.emit(
          'data',
          `${JSON.stringify({ id: request.id, ok: true, result: this.replies[request.method] })}\n`
        )
      )
    }
    return true
  }

  end(): void {
    this.destroyed = true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

class FakeProvider extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn()
  unref = vi.fn()
}

function capabilities(permissionStatus: boolean) {
  return {
    platform: 'darwin',
    protocolVersion: 1,
    supports: {
      actions: {},
      apps: { list: true },
      ...(permissionStatus ? { permissions: { status: true } } : {})
    }
  }
}

describe('MacOSNativeProviderClient.permissionStatus', () => {
  const sockets: AutoReplySocket[] = []
  let replies: Replies

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    sockets.length = 0
    replies = {
      handshake: capabilities(true),
      permissionStatus: { accessibility: 'granted', screenshots: 'granted' },
      listApps: { apps: [] }
    }
    spawnMock.mockImplementation(() => new FakeProvider())
    connectMock.mockImplementation(async () => {
      const socket = new AutoReplySocket({ ...replies })
      sockets.push(socket)
      return socket
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  async function createClient() {
    vi.resetModules()
    const { MacOSNativeProviderClient } = await import('./macos-native-provider-client')
    return new MacOSNativeProviderClient()
  }

  it('asks the running provider instead of launching a probe', async () => {
    const client = await createClient()

    await expect(client.permissionStatus({ fresh: false })).resolves.toEqual({
      accessibility: 'granted',
      screenshots: 'granted'
    })
    await client.permissionStatus({ fresh: false })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]![1]).toContain('--agent')
    expect(sockets[0]!.methods).toEqual(['handshake', 'permissionStatus', 'permissionStatus'])
  })

  it('never sends the request to a provider that does not advertise it', async () => {
    replies.handshake = capabilities(false)
    const client = await createClient()

    await expect(client.permissionStatus({ fresh: false })).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
    expect(sockets[0]!.methods).toEqual(['handshake'])
  })

  it('restarts the provider for a fresh read', async () => {
    const client = await createClient()
    await client.permissionStatus({ fresh: false })

    await client.permissionStatus({ fresh: true })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(sockets[0]!.methods).toContain('terminate')
    expect(sockets[1]!.methods).toEqual(['handshake', 'permissionStatus'])
  })

  it('rereads an incomplete status from a new provider that only served status reads', async () => {
    replies.permissionStatus = { accessibility: 'granted', screenshots: 'not-granted' }
    const client = await createClient()
    await client.permissionStatus({ fresh: false })

    replies.permissionStatus = { accessibility: 'granted', screenshots: 'granted' }
    await expect(client.permissionStatus({ fresh: false })).resolves.toEqual({
      accessibility: 'granted',
      screenshots: 'granted'
    })
    await client.permissionStatus({ fresh: false })

    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('restarts at most once per status read and never on its own', async () => {
    replies.permissionStatus = { accessibility: 'granted', screenshots: 'not-granted' }
    const client = await createClient()
    for (let read = 0; read < 3; read++) {
      await client.permissionStatus({ fresh: false })
    }
    expect(spawnMock).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })

  it('never recycles a provider after agent work, however many incomplete reads follow', async () => {
    replies.permissionStatus = { accessibility: 'granted', screenshots: 'not-granted' }
    const client = await createClient()
    await client.listApps()

    await client.permissionStatus({ fresh: false })
    await client.permissionStatus({ fresh: false })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.methods).not.toContain('terminate')
  })

  it('does not recycle when only Accessibility is missing', async () => {
    replies.permissionStatus = { accessibility: 'not-granted', screenshots: 'granted' }
    const client = await createClient()

    await client.permissionStatus({ fresh: false })
    await client.permissionStatus({ fresh: false })

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a provider that is serving agent work', async () => {
    replies.permissionStatus = { accessibility: 'granted', screenshots: 'not-granted' }
    const client = await createClient()
    await client.permissionStatus({ fresh: false })
    await client.listApps()

    await client.permissionStatus({ fresh: false })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.methods).toEqual([
      'handshake',
      'permissionStatus',
      'listApps',
      'permissionStatus'
    ])
  })
})
