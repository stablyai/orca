import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  chmodSyncMock,
  connectMacOSProviderSocketMock,
  mkdtempSyncMock,
  resolveMacOSComputerUseExecutablePathMock,
  rmSyncMock,
  spawnMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  connectMacOSProviderSocketMock: vi.fn(),
  mkdtempSyncMock: vi.fn(),
  resolveMacOSComputerUseExecutablePathMock: vi.fn(),
  rmSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('fs', () => ({
  chmodSync: chmodSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseExecutablePath: resolveMacOSComputerUseExecutablePathMock
}))

vi.mock('./macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMacOSProviderSocketMock
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: string[] = []
  writeError: Error | null = null

  setEncoding(): void {}

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line)
    callback?.(this.writeError)
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

  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

async function loadClientModule() {
  vi.resetModules()
  return await import('./macos-native-provider-client')
}

describe('MacOSNativeProviderClient', () => {
  const sockets: FakeSocket[] = []
  const providers: FakeProvider[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    providers.length = 0
    mkdtempSyncMock.mockImplementation((prefix: string) => `${prefix}${sockets.length}`)
    resolveMacOSComputerUseExecutablePathMock.mockReturnValue(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    )
    spawnMock.mockImplementation(() => {
      const provider = new FakeProvider()
      providers.push(provider)
      return provider
    })
    connectMacOSProviderSocketMock.mockImplementation(async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
  })

  afterEach(() => {
    for (const result of spawnMock.mock.results) {
      if (result.value instanceof FakeProvider) {
        result.value.exit()
      }
    }
    chmodSyncMock.mockReset()
    connectMacOSProviderSocketMock.mockReset()
    mkdtempSyncMock.mockReset()
    resolveMacOSComputerUseExecutablePathMock.mockReset()
    rmSyncMock.mockReset()
    spawnMock.mockReset()
    writeFileSyncMock.mockReset()
    vi.useRealTimers()
  })

  it('reaps the helper process of a superseded startup', async () => {
    const pendingConnects: {
      resolve: (socket: FakeSocket) => void
    }[] = []
    connectMacOSProviderSocketMock.mockImplementation(
      async () =>
        await new Promise<FakeSocket>((resolve) => {
          pendingConnects.push({ resolve })
        })
    )
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(1))

    client.shutdown()

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(2))
    const secondSocket = new FakeSocket()
    pendingConnects[1]!.resolve(secondSocket)
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    pendingConnects[0]!.resolve(new FakeSocket())
    await expect(firstCall).rejects.toThrow('native macOS provider startup was superseded')

    expect(providers[0]!.kill).toHaveBeenCalledTimes(1)
    expect(providers[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(providers[1]!.kill).not.toHaveBeenCalled()

    secondSocket.emit(
      'data',
      `${JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(secondCall).resolves.toMatchObject({ protocolVersion: 1 })
  })
})
